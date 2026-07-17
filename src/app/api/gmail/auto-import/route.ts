import { NextRequest, NextResponse } from 'next/server';
import { searchPOEmails, getMessage, getPdfAttachments, getHeader } from '@/lib/google';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';

// This route is called by Vercel Cron every 20 minutes
// It searches Gmail for new PO emails and auto-imports them

// Each email goes through a Claude PDF extraction (10–40s). The old 60s
// ceiling meant one slow email mid-loop blew through the wall and Vercel
// killed the whole run (504 → "auto import failed"), while the manual
// email-button flow worked because each click got its own fresh window.
// Give the batch real room, and cap work per run below.
export const maxDuration = 300;

// Fresh extractions per run. Anything beyond this defers to the next run —
// the 2-day search window overlaps, so deferred emails are never lost.
const MAX_IMPORTS_PER_RUN = 8;

const SYNC_TYPE = 'gmail_auto_import';

async function recordRun(
  supabase: any,
  result: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const wroteAt = new Date().toISOString();
    const { error } = await supabase.from('sync_state').upsert({
      sync_type: SYNC_TYPE,
      last_synced_at: wroteAt,
      last_result: result,
      updated_at: wroteAt,
    }, { onConflict: 'sync_type' });
    if (error) {
      console.error('[gmail-auto-import] sync_state upsert error:', error);
      return { ok: false, error: error.message || JSON.stringify(error) };
    }
    // Trust but verify: an upsert can report success while the row stays
    // stale (RLS filtering the conflict-update path writes nothing and
    // raises nothing). Read the row back — a heartbeat that didn't land
    // is a failure, and the caller needs the evidence. Compare as epoch
    // times, NOT strings: Postgres renders the same instant as
    // "…51.11+00:00" while JS wrote "…51.110Z", and a string compare
    // wrongly flags a landed write. A minute of tolerance absorbs clock
    // skew between this function and the database.
    const { data: check } = await supabase
      .from('sync_state')
      .select('last_synced_at')
      .eq('sync_type', SYNC_TYPE)
      .maybeSingle();
    const landedAt = check?.last_synced_at ? new Date(check.last_synced_at).getTime() : NaN;
    if (!(landedAt >= new Date(wroteAt).getTime() - 60_000)) {
      const msg = `upsert reported success but read-back shows ${check?.last_synced_at || 'no row at all'}`;
      console.error('[gmail-auto-import] sync_state phantom write:', msg);
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (err: any) {
    console.error('[gmail-auto-import] failed to persist sync_state:', err?.message);
    return { ok: false, error: err?.message || 'unknown sync_state write failure' };
  }
}

export async function GET(req: NextRequest) {
  // Allow Vercel Cron with the shared secret; anyone else needs an admin
  // session (manual trigger from the POs page). Fails closed if CRON_SECRET
  // is not configured.
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  try {
    // Search last 2 days of emails (overlap to catch anything missed)
    const afterDate = new Date();
    afterDate.setDate(afterDate.getDate() - 2);
    const afterStr = `${afterDate.getFullYear()}/${afterDate.getMonth() + 1}/${afterDate.getDate()}`;

    const messages = await searchPOEmails(afterStr);
    if (messages.length === 0) {
      const w = await recordRun(supabase, { status: 'ok', messagesFound: 0, imported: 0, skipped: 0, errors: 0 });
      return NextResponse.json({ message: 'No PO emails found', imported: 0, skipped: 0, syncStateWrite: w });
    }

    // Get already-processed message IDs
    const messageIds = messages.map((m: any) => m.id);
    const { data: existing } = await supabase
      .from('gmail_po_imports')
      .select('message_id, status')
      .in('message_id', messageIds);
    const processedMap = new Map((existing || []).map((e: any) => [e.message_id, e.status]));

    // Get existing PO numbers
    const { data: existingPOs } = await supabase
      .from('purchase_orders')
      .select('po_number');
    const existingPoNumbers = new Set((existingPOs || []).map((p: any) => p.po_number));

    let imported = 0;
    let skipped = 0;
    let errors = 0;
    let deferred = 0;
    const results: any[] = [];

    // Stop cleanly before Vercel hard-kills the function so we still return a
    // summary and write sync_state. Anything not reached this run is picked up
    // next run (the 2-day search window overlaps), instead of being silently
    // dropped mid-loop with no record of why. The headroom must cover a WHOLE
    // import (the budget is checked before each message, but the message then
    // runs to completion) — track the slowest import so far and keep at least
    // that much, so one slow PDF can't push the run past the wall.
    const startedAt = Date.now();
    const totalBudgetMs = maxDuration * 1000;
    let slowestImportMs = 45_000; // pessimistic floor until we've measured one
    let freshImports = 0;

    for (const msg of messages) {
      const id = msg.id!;

      // Skip already processed. 'pending' counts too: the email is already
      // extracted and sitting in the review queue — re-extracting it every
      // 20 minutes burns a 10-40s AI call per run, can defer genuinely new
      // emails behind it, and re-fires the "new PO" notification each time.
      // ('error' rows still retry: their failures may be transient.)
      const existingStatus = processedMap.get(id);
      if (existingStatus === 'imported' || existingStatus === 'skipped' || existingStatus === 'pending') {
        skipped++;
        continue;
      }

      const elapsed = Date.now() - startedAt;
      const headroomMs = Math.max(60_000, slowestImportMs * 1.5);
      if (elapsed > totalBudgetMs - headroomMs || freshImports >= MAX_IMPORTS_PER_RUN) {
        deferred++;
        continue;
      }
      freshImports++;
      const importStarted = Date.now();

      try {
        // Call the import-po endpoint in extractOnly mode — queue for manual review
        const importRes = await fetch(new URL('/api/gmail/import-po', req.url), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({ messageId: id, extractOnly: true }),
        });

        // import-po can 504 under load, in which case Vercel returns an HTML
        // error page. Blindly calling .json() on that throws and the message
        // would be miscounted with a useless "Unexpected token <" error, so
        // parse defensively and surface the real HTTP status instead.
        const raw = await importRes.text();
        let result: any;
        try {
          result = JSON.parse(raw);
        } catch {
          errors++;
          results.push({
            messageId: id,
            status: 'error',
            error: `import-po returned non-JSON (HTTP ${importRes.status})`,
          });
          continue;
        }

        if (result.status === 'imported' || result.status === 'review') {
          imported++;
          results.push({ messageId: id, status: result.status, poNumber: result.poNumber || result.extracted?.po_number });
        } else if (result.status === 'skipped' || result.status === 'exists') {
          skipped++;
          results.push({ messageId: id, status: 'skipped', reason: result.reason });
        } else {
          errors++;
          results.push({ messageId: id, status: 'error', error: result.error });
        }
      } catch (err: any) {
        errors++;
        results.push({ messageId: id, status: 'error', error: err.message });
      }

      slowestImportMs = Math.max(slowestImportMs, Date.now() - importStarted);

      // Small delay between imports to avoid rate limits
      await new Promise(r => setTimeout(r, 250));
    }

    // Send notification to users who opted in for PO alerts
    if (imported > 0) {
      const { data: poPrefs } = await supabase
        .from('notification_preferences')
        .select('user_id')
        .eq('notify_new_po', true);
      const adminIds = (poPrefs || []).map((p: any) => p.user_id);
      if (adminIds.length > 0) {
        const poNumbers = results
          .filter((r: any) => r.status === 'review' || r.status === 'imported')
          .map((r: any) => r.poNumber)
          .filter(Boolean)
          .join(', ');
        fetch(new URL('/api/notifications/send', req.url), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({
            userIds: adminIds,
            type: 'po_pending',
            title: `${imported} new PO${imported !== 1 ? 's' : ''} pending review`,
            body: poNumbers ? `PO #${poNumbers}` : 'New purchase orders found in Gmail',
            url: '/admin/pos',
          }),
        }).catch(() => {});
      }
    }

    // After importing POs, retroactively match unmatched scans
    if (imported > 0) {
      try {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
        await fetch(`${appUrl}/api/scans/match-po`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
        });
      } catch (err) {
        console.warn('Retroactive scan match failed:', err);
      }
    }

    const okWrite = await recordRun(supabase, {
      status: 'ok',
      messagesFound: messages.length,
      imported,
      skipped,
      errors,
      deferred,
      // Cap stored results so the jsonb stays small. The first few are
      // enough to debug; the UI panel just shows summary counts anyway.
      sample: results.slice(0, 10),
    });

    return NextResponse.json({
      message: `Processed ${messages.length} emails`,
      imported,
      skipped,
      errors,
      deferred,
      results,
      syncStateWrite: okWrite,
    });
  } catch (err: any) {
    if (err.message === 'NO_GOOGLE_TOKEN') {
      const w = await recordRun(supabase, { status: 'error', reason: 'NO_GOOGLE_TOKEN' });
      return NextResponse.json({ error: 'Gmail not connected', needsAuth: true, syncStateWrite: w }, { status: 401 });
    }
    console.error('Auto-import error:', err);
    const w = await recordRun(supabase, { status: 'error', error: err?.message || 'unknown' });
    return NextResponse.json({ error: err.message || 'Auto-import failed', syncStateWrite: w }, { status: 500 });
  }
}
