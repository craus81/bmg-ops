import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { logAudit } from '@/lib/audit';
import { LEDGER_SETTINGS_KEY, ledgerPdfsEnabled, readLedgerSettings } from '@/lib/ledger/pdf-gate';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * The ledger settings block: the R2 PDF gate and the confirmed cutover.
 *
 * READ is requireAdmin — this version carries `stampedBy`, i.e. WHO said the
 * privacy flip was verified. The finance/executive-visible copy of the gate
 * (without the who) rides on /api/admin/quickbooks/status instead, so the
 * ledger page can show a reader the notice without 403ing.
 *
 * WRITE is super admin: stamping the gate is the decision that lets the
 * importer put a decade of financial PDFs into R2 (owner item 4).
 */

const putSchema = z.object({ pdfsEnabled: z.literal(true) });

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const service = createServiceClient();
  try {
    const [gate, settings] = await Promise.all([ledgerPdfsEnabled(service), readLedgerSettings(service)]);
    return NextResponse.json({
      pdfs: {
        enabled: gate.enabled,
        via: gate.via,
        stampedAt: settings.pdfs_enabled_at ?? null,
        stampedBy: settings.pdfs_enabled_by ?? null,
        reason: gate.reason,
      },
      cutover: settings.cutover ?? null,
    });
  } catch (e: any) {
    // "Could not read" is not "off" — say which (R7-1).
    return NextResponse.json(
      { error: `Could not read the ledger settings: ${String(e?.message || e).slice(0, 200)}` },
      { status: 503 },
    );
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, putSchema);
  if (parsed.error) return parsed.error;

  const service = createServiceClient();
  let current;
  try {
    current = await readLedgerSettings(service);
  } catch (e: any) {
    return NextResponse.json(
      { error: `Could not read the ledger settings: ${String(e?.message || e).slice(0, 200)}` },
      { status: 503 },
    );
  }

  const stampedAt = new Date().toISOString();
  const { error } = await service.from('app_settings').upsert(
    {
      key: LEDGER_SETTINGS_KEY,
      value: { ...current, pdfs_enabled_at: stampedAt, pdfs_enabled_by: auth.user.id },
    },
    { onConflict: 'key' },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'app_settings',
    recordId: LEDGER_SETTINGS_KEY,
    action: 'ledger_pdfs_enabled',
    detail: { stampedAt },
  });

  return NextResponse.json({ ok: true, stampedAt });
}
