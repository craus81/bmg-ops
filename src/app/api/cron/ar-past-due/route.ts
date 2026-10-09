import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { recordHeartbeat } from '@/lib/system-health';
import { fetchAllRows } from '@/lib/fetch-all';
import { fetchOpenArInvoices } from '@/lib/financials-data';
import { resolveArSettings, newCrossings, groupPastDue, buildArDigest } from '@/lib/ar-reminders';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const service = createServiceClient();

/** Hour on the shop's clock (America/Chicago). */
function chicagoHour(at: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }).format(at));
}

/**
 * Weekday-morning past-due sweep (owner decisions 2026-10-09).
 *
 * Reads every open invoice from NetSuite, finds the ones that reached a new
 * step (1/15/30/60 days past due by default, Settings on the Past Due page)
 * and sends the A/R contacts ONE digest — email now plus in-app — linking to
 * /invoices/past-due. Each (invoice, step) is logged so it alerts once.
 * Customers are never emailed from here.
 *
 * vercel.json fires at 12:07 and 13:07 UTC on weekdays; only the run that
 * lands at 7 AM Central does anything, so the email arrives at 7 year-round
 * across daylight saving. A manual (admin) run always runs.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  if (isCron && chicagoHour() !== 7) {
    return NextResponse.json({ skipped: 'not 7 AM Central' });
  }

  try {
    const { data: settingsRow } = await service.from('ar_reminder_settings').select('*').eq('id', 1).maybeSingle();
    const settings = resolveArSettings(settingsRow);
    if (!settings.enabled) {
      await recordHeartbeat(service, 'ar_past_due_check', { status: 'ok', disabled: true });
      return NextResponse.json({ status: 'disabled' });
    }

    const { invoices } = await fetchOpenArInvoices();

    const { data: logged, error: logErr } = await fetchAllRows<{ invoice_id: string; step: number }>((from, to) => service
      .from('ar_reminder_log')
      .select('invoice_id, step')
      .order('invoice_id')
      .order('step')
      .range(from, to));
    if (logErr) throw new Error(`reading ar_reminder_log: ${logErr.message}`);
    const alerted = new Set(logged.map(r => `${r.invoice_id}:${r.step}`));

    const crossings = newCrossings(invoices, settings.stepDays, alerted);
    const allPastDue = groupPastDue(invoices);

    let notified = 0;
    if (crossings.length > 0 && settings.recipientIds.length > 0) {
      const { data: people } = await service
        .from('profiles').select('id').in('id', settings.recipientIds).eq('status', 'approved');
      const ids = (people || []).map(p => p.id);
      if (ids.length > 0) {
        const digest = buildArDigest(crossings, allPastDue);
        await notifyMany(ids, {
          type: 'ar_past_due',
          title: digest.title,
          body: digest.body.slice(0, 2000),
          // A digest of one customer opens that customer's row.
          url: deepLinks.pastDue(new Set(crossings.map(c => c.invoice.entityId)).size === 1 ? crossings[0].invoice.entityId : null),
          channels: ['in_app', 'email'],
        });
        notified = ids.length;
      }
    }

    // Log only after the digest went out (or when nobody is set to receive
    // it, so a later recipient isn't greeted with weeks of backlog).
    if (crossings.length > 0) {
      const stamp = new Date().toISOString();
      const rows = crossings.map(c => ({
        invoice_id: c.invoice.id,
        step: c.step,
        tranid: c.invoice.tranid,
        entity_id: c.invoice.entityId,
        customer: c.invoice.customer,
        days_past_due: c.invoice.daysPastDue,
        amount: Math.round(c.invoice.unpaid * 100) / 100,
        alerted_at: stamp,
      }));
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await service.from('ar_reminder_log').upsert(rows.slice(i, i + 500), { onConflict: 'invoice_id,step', ignoreDuplicates: true });
        if (error) throw new Error(`writing ar_reminder_log: ${error.message}`);
      }
    }

    const result = {
      status: 'ok',
      openInvoices: invoices.length,
      pastDueCustomers: allPastDue.length,
      crossed: crossings.length,
      notified,
    };
    await recordHeartbeat(service, 'ar_past_due_check', result);
    return NextResponse.json(result);
  } catch (e: any) {
    console.error('ar-past-due failed:', e);
    await recordHeartbeat(service, 'ar_past_due_check', { error: e.message || 'AR past-due check failed' });
    return NextResponse.json({ error: e.message || 'AR past-due check failed' }, { status: 500 });
  }
}
