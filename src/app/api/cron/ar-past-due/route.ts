import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { recordHeartbeat } from '@/lib/system-health';
import { fetchAllRows } from '@/lib/fetch-all';
import { fetchOpenArInvoices } from '@/lib/financials-data';
import { resolveArSettings, newCrossings, groupPastDue, buildArDigest } from '@/lib/ar-reminders';
import { sweepCustomerHolds, holdChangeLines, salesRepFor, type HoldChange } from '@/lib/customer-hold-server';

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
 * It also sets the customer holds (migration 366): any invoice hold_days
 * (60) past due puts the customer On hold. Who went on or came off hold
 * rides in the same A/R email; each sales rep hears about their own
 * customers separately.
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

    const { invoices } = await fetchOpenArInvoices();

    // Customer holds (migration 366) run whether or not the reminder email is on.
    const holds = await sweepCustomerHolds(service, invoices, settings.holdDays);

    const { data: logged, error: logErr } = await fetchAllRows<{ invoice_id: string; step: number }>((from, to) => service
      .from('ar_reminder_log')
      .select('invoice_id, step')
      .order('invoice_id')
      .order('step')
      .range(from, to));
    if (logErr) throw new Error(`reading ar_reminder_log: ${logErr.message}`);
    const alerted = new Set(logged.map(r => `${r.invoice_id}:${r.step}`));

    const crossings = settings.enabled ? newCrossings(invoices, settings.stepDays, alerted) : [];
    const allPastDue = groupPastDue(invoices);
    const holdLines = holdChangeLines(holds.placed, holds.lifted);

    // A/R contacts: ONE email a morning — the step crossings plus who went
    // on or came off hold today.
    const { data: people } = settings.recipientIds.length
      ? await service.from('profiles').select('id').in('id', settings.recipientIds).eq('status', 'approved')
      : { data: [] as { id: string }[] };
    const arIds = (people || []).map(p => p.id);
    let notified = 0;
    if (arIds.length > 0 && (crossings.length > 0 || holdLines.length > 0)) {
      const digest = crossings.length > 0 ? buildArDigest(crossings, allPastDue) : null;
      const holdTitle = `${holds.placed.length ? `⛔ ${holds.placed.length} customer${holds.placed.length === 1 ? '' : 's'} went on hold` : ''}${holds.placed.length && holds.lifted.length ? ', ' : ''}${holds.lifted.length ? `✅ ${holds.lifted.length} came off hold` : ''}`;
      const entities = new Set([...crossings.map(c => c.invoice.entityId), ...holds.placed.map(h => h.netsuiteId), ...holds.lifted.map(h => h.netsuiteId)]);
      await notifyMany(arIds, {
        type: 'ar_past_due',
        title: digest ? `${digest.title}${holdTitle ? ` · ${holdTitle}` : ''}` : holdTitle,
        body: [
          holdLines.length ? holdLines.join('\n') : '',
          digest ? digest.body : 'Open the Past Due page to see every past-due customer.',
        ].filter(Boolean).join('\n\n').slice(0, 2500),
        // A digest of one customer opens that customer's row.
        url: deepLinks.pastDue(entities.size === 1 ? [...entities][0] : null),
        channels: ['in_app', 'email'],
      });
      notified = arIds.length;
    }

    // Sales reps hear about their own customers' holds (A/R already has it above).
    const byRep = new Map<string, { placed: HoldChange[]; lifted: HoldChange[] }>();
    for (const [kind, list] of [['placed', holds.placed], ['lifted', holds.lifted]] as const) {
      for (const c of list) {
        const rep = await salesRepFor(service, c.netsuiteId, c.customerId);
        if (!rep || arIds.includes(rep)) continue;
        const cur = byRep.get(rep) || { placed: [], lifted: [] };
        cur[kind].push(c);
        byRep.set(rep, cur);
      }
    }
    for (const [rep, mine] of byRep) {
      const all = [...mine.placed, ...mine.lifted];
      const lines = holdChangeLines(mine.placed, mine.lifted);
      await notifyMany([rep], {
        type: 'customer_hold',
        title: all.length === 1
          ? (mine.placed.length ? `⛔ ${all[0].customer} is on hold for past-due invoices` : `✅ ${all[0].customer} is off hold`)
          : `${all.length} of your customers changed hold status`,
        body: `${lines.join('\n')}\nWhile a customer is on hold, sending an estimate or quote and creating a sales order need an admin or A/R override with a reason. Let the customer know their account is on hold for nonpayment.`,
        url: all.length === 1 ? deepLinks.customerByNetsuiteId(all[0].netsuiteId) : deepLinks.pastDue(),
        channels: ['in_app', 'push', 'email'],
      });
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
      onHold: holds.onHold,
      holdsPlaced: holds.placed.length,
      holdsLifted: holds.lifted.length,
    };
    await recordHeartbeat(service, 'ar_past_due_check', result);
    return NextResponse.json(result);
  } catch (e: any) {
    console.error('ar-past-due failed:', e);
    await recordHeartbeat(service, 'ar_past_due_check', { error: e.message || 'AR past-due check failed' });
    return NextResponse.json({ error: e.message || 'AR past-due check failed' }, { status: 500 });
  }
}
