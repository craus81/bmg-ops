import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getRequestIp } from '@/lib/magic-link-approval';
import { buildFeed, loadCompanyJobs } from '@/lib/cni-schedule-feed';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/cni/schedule/<token>.ics — a CNI company's install schedule as an
 * iCalendar subscription (R6-8, migration 300).
 *
 * No session: the link's token is the credential, the customer PO-portal
 * pattern (migration 260) pointed at installers. A calendar client cannot
 * carry a login, so a subscribe-once URL is the only shape this can take —
 * which is why the token is a UUID, the feed is read-only, and revoking it
 * from the company record kills every existing subscription instantly.
 *
 * The payload is only the jobs already assigned to that company: the same
 * records their installers open in the portal, nothing wider.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  // Every device at a company polls this on its own timer, and a crew shares
  // one office IP — a much looser ceiling than a one-shot approval page, and
  // still far below what guessing a UUID would need.
  if (!await checkRateLimit(ip, 'cni_schedule_feed', 240)) {
    return new NextResponse('Too many requests — try again in a little while.', {
      status: 429,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // The `.ics` suffix lives on this segment so the URL ends in the extension
  // some calendar clients still sniff. Strip it before matching the token.
  const token = String(params.token || '').trim().replace(/\.ics$/i, '');
  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    return new NextResponse('This calendar link is not valid.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const { data: company } = await service
    .from('companies')
    .select('id, name, schedule_token')
    .eq('schedule_token', token)
    .maybeSingle();
  if (!company) {
    // A revoked or regenerated link lands here. 404 rather than an empty
    // calendar on purpose: an empty feed reads as "no work booked", which is
    // a different and much worse thing to tell a crew than "this link is
    // dead" — their client surfaces the error and someone asks for a new one.
    return new NextResponse('This calendar link is no longer active. Ask your BMG coordinator for a new one.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  let ics: string;
  try {
    const jobs = await loadCompanyJobs(service, company.id);
    ics = buildFeed(jobs, { companyName: company.name || 'BMG' }).ics;
  } catch (e: any) {
    console.error('cni schedule feed failed:', e);
    // 503, never a 200 with an empty VCALENDAR: a client handed an empty
    // calendar deletes every event it had cached, so one bad read would wipe
    // the crew's week. An error leaves the last good copy in place.
    return new NextResponse('The schedule could not be loaded right now.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // Best-effort "somebody's calendar actually pulled this" stamp — the only
  // way to tell a live subscription from a link that was merely issued.
  service.from('companies').update({ schedule_last_fetched_at: new Date().toISOString() }).eq('id', company.id)
    .then(() => undefined, () => undefined);

  return new NextResponse(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="bmg-installs.ics"',
      // `private` keeps a token-addressed feed out of shared caches; the
      // short max-age just stops a client that polls hard from re-querying
      // on every retry.
      'Cache-Control': 'private, max-age=300',
    },
  });
}
