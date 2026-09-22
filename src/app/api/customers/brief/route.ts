import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff, getProfileRoles } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { canSeeFinancials } from '@/lib/ai-agent-access';
import { callAnthropicWithRetry } from '@/lib/anthropic';
import { gatherBriefFacts } from '@/lib/customer-brief-data';
import { BRIEF_SYSTEM_PROMPT, buildBriefPrompt, factLines, unknownSections } from '@/lib/customer-brief';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST /api/customers/brief — the pre-call rundown (R6-13, audit line 415b).
 *
 * Gathers open estimates, A/R, vehicles in the shop, email deliverability,
 * open threads, spend and the recent activity log for one customer, then has
 * Claude compress it into a short brief.
 *
 * Three things this route refuses to do:
 *
 *  1. Turn an unreadable section into a zero. Every section carries its own
 *     status; the response returns them, the prompt forbids inventing a
 *     figure for one, and `unknownSections` names them so the reader can
 *     see the brief is partial.
 *  2. Give a non-financial caller A/R. `includeAr` is the caller's own
 *     access, resolved here from their server-side roles.
 *  3. Fail because the model is unavailable. With no API key or on any
 *     error, the deterministic `factLines` rendering is returned with
 *     `source: 'facts'` — plainer prose, identical numbers, never absent.
 */

const Schema = z.object({
  prospectId: z.string().uuid().optional(),
  /** NetSuite internal id, for accounts with no CRM row. */
  netsuiteId: z.string().regex(/^\d{1,15}$/).optional(),
}).refine(v => !!(v.prospectId || v.netsuiteId), {
  message: 'prospectId or netsuiteId is required',
});

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 700;

export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const roles = getProfileRoles(auth.profile);
  const includeAr = canSeeFinancials(roles);

  let facts;
  try {
    facts = await gatherBriefFacts(service, parsed.data, { includeAr });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Could not gather the brief.' }, { status: 500 });
  }
  if (!facts) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });

  const lines = factLines(facts);
  const unknown = unknownSections(facts);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({
      brief: lines.join('\n'),
      source: 'facts',
      note: 'AI summarizing is not configured on this deployment, so these are the raw findings.',
      lines, facts, unknown,
    });
  }

  try {
    const res = await callAnthropicWithRetry({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: BRIEF_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildBriefPrompt(facts) }],
    }, apiKey);

    if (!res.ok) throw new Error(`Claude returned ${res.status}`);
    const body = await res.json();
    const text = (body?.content || [])
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text)
      .join('\n')
      .trim();
    if (!text) throw new Error('empty response');

    // `lines` rides back with the prose so the UI can show the findings the
    // brief was written from. A summary and its evidence must be separable.
    return NextResponse.json({ brief: text, source: 'ai', lines, facts, unknown });
  } catch (e: any) {
    // The findings are already in hand — a model outage downgrades the
    // prose, it does not lose the brief.
    return NextResponse.json({
      brief: lines.join('\n'),
      source: 'facts',
      note: `The summarizer was unavailable (${e?.message || 'error'}), so these are the raw findings.`,
      lines, facts, unknown,
    });
  }
}
