import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { recordHeartbeat } from '@/lib/system-health';
import { evaluateAtRiskCustomers } from '@/lib/at-risk';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

/**
 * Daily at-risk account sweep: flags customers who spent real money last
 * year and have gone quiet this year, and alerts admins + the account's
 * sales rep about NEWLY flagged accounts (the full list lives on the
 * report page — no daily re-spam for accounts already known to be at risk).
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  try {
    const { flagged, scanned } = await evaluateAtRiskCustomers(service);

    // Newly at-risk = flagged now but not in the previous run's snapshot.
    const { data: state } = await service
      .from('sync_state').select('last_result').eq('sync_type', 'at_risk_check').maybeSingle();
    const previousIds = new Set<string>(((state?.last_result as any)?.flagged_ids as string[]) || []);
    const fresh = flagged.filter(c => !previousIds.has(c.netsuite_id));

    let notified = 0;
    if (fresh.length > 0) {
      const { data: admins } = await service
        .from('profiles')
        .select('id')
        .or('role.eq.admin,roles.cs.{admin}')
        .eq('status', 'approved');
      const adminIds = (admins || []).map(a => a.id);
      const fmtK = (n: number) => n >= 1000 ? `$${(n / 1000).toFixed(0)}k` : `$${n.toFixed(0)}`;

      // One digest to admins; a per-account nudge to the owning rep.
      if (adminIds.length > 0) {
        const lines = fresh
          .map(c => `${c.company_name} (${fmtK(c.last_year_spend)} last yr → ${fmtK(c.ytd_spend)} YTD${c.days_quiet != null ? `, quiet ${c.days_quiet}d` : ''})`)
          .join(' · ');
        await notifyMany(adminIds, {
          type: 'at_risk_account',
          title: `⚠ ${fresh.length} account${fresh.length !== 1 ? 's' : ''} newly at risk`,
          body: lines.slice(0, 900),
          // Digest: multi-account batches land on the report; a lone account
          // opens flashed on its row.
          url: fresh.length === 1 ? deepLinks.atRiskCustomer(fresh[0].id) : '/admin/reports/at-risk',
          channels: ['in_app', 'push'],
          forceChannels: true,
        });
        notified += adminIds.length;
      }
      for (const c of fresh) {
        if (c.account_owner_id && !adminIds.includes(c.account_owner_id)) {
          await notifyMany([c.account_owner_id], {
            type: 'at_risk_account',
            title: `⚠ Your account ${c.company_name} has gone quiet`,
            body: `${fmtK(c.last_year_spend)} last year, ${fmtK(c.ytd_spend)} this year${c.days_quiet != null ? ` — no orders in ${c.days_quiet} days` : ''}. Worth a call.`,
            url: deepLinks.atRiskCustomer(c.id),
            channels: ['in_app', 'push'],
            forceChannels: true,
          });
          notified += 1;
        }
      }
    }

    const syncStateWrite = await recordHeartbeat(service, 'at_risk_check', {
      status: 'ok',
      scanned,
      flagged: flagged.length,
      new: fresh.length,
      flagged_ids: flagged.map(c => c.netsuite_id),
    });

    return NextResponse.json({ status: 'ok', scanned, flagged: flagged.length, new: fresh.length, notified, syncStateWrite });
  } catch (e: any) {
    console.error('at-risk-check failed:', e);
    // Record the failure so System Health surfaces it.
    await recordHeartbeat(service, 'at_risk_check', { error: e.message || 'at-risk check failed' }); // never throws; failure already logged
    return NextResponse.json({ error: e.message || 'at-risk check failed' }, { status: 500 });
  }
}
