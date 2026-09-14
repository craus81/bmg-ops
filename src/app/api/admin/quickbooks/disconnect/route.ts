import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { logAudit } from '@/lib/audit';
import { maskRealm } from '@/lib/quickbooks/config';
import { revokeToken } from '@/lib/quickbooks/oauth';
import { clearConnection } from '@/lib/quickbooks/tokens';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST /api/admin/quickbooks/disconnect — super admin only.
 *
 * Owner-level because it stops the history import for everyone and revokes
 * the app's access at Intuit. Imported rows STAY: the ledger is a record of
 * what QuickBooks said, and disconnecting is about credentials, not data.
 *
 * The revoke is best effort and the row is cleared either way — a token we
 * cannot revoke is at least a token we stop holding.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const service = createServiceClient();
  const { data: row } = await service
    .from('quickbooks_tokens')
    .select('realm_id, refresh_token')
    .eq('id', 1)
    .maybeSingle();
  if (!row) return NextResponse.json({ ok: true, alreadyDisconnected: true });

  await revokeToken(String(row.refresh_token));
  await clearConnection(service);

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'quickbooks_tokens',
    recordId: '1',
    action: 'qbo_disconnected',
    // Masked, like every other realm mention outside quickbooks_tokens.
    detail: { realmMasked: maskRealm(String(row.realm_id)) },
  });

  return NextResponse.json({ ok: true });
}
