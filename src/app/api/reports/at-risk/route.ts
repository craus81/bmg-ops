import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { evaluateAtRiskCustomers, AT_RISK_DEFAULTS } from '@/lib/at-risk';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;

  const minSpendRaw = Number(req.nextUrl.searchParams.get('minSpend'));
  const quietDaysRaw = Number(req.nextUrl.searchParams.get('quietDays'));
  const minLastYearSpend = Number.isFinite(minSpendRaw) && minSpendRaw >= 0
    ? minSpendRaw : AT_RISK_DEFAULTS.minLastYearSpend;
  const quietDays = Number.isFinite(quietDaysRaw) && quietDaysRaw >= 0
    ? quietDaysRaw : AT_RISK_DEFAULTS.quietDays;
  const includeDismissed = req.nextUrl.searchParams.get('includeDismissed') === '1';

  try {
    const result = await evaluateAtRiskCustomers(service, { minLastYearSpend, quietDays, includeDismissed });

    // Resolve account-owner names for the table.
    const ownerIds = [...new Set(result.flagged.map(c => c.account_owner_id).filter(Boolean))] as string[];
    const owners: Record<string, string> = {};
    if (ownerIds.length > 0) {
      const { data } = await service.from('profiles').select('id, full_name').in('id', ownerIds);
      for (const p of data || []) owners[p.id] = p.full_name;
    }

    return NextResponse.json({
      flagged: result.flagged.map(c => ({ ...c, account_owner_name: c.account_owner_id ? owners[c.account_owner_id] || null : null })),
      scanned: result.scanned,
      options: result.options,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Report failed' }, { status: 500 });
  }
}
