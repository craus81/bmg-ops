import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { maskRealm, qboConfig, qboConfigured } from '@/lib/quickbooks/config';
import { ledgerPdfsEnabled, readLedgerSettings } from '@/lib/ledger/pdf-gate';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET /api/admin/quickbooks/status — the connection card the ledger page
 * loads first.
 *
 * `requireRole(req, ['finance','executive'])` — the ledger reader tier
 * (admins and super admins auto-pass inside requireRole).
 *
 * The `pdfGate` block lives HERE deliberately. /api/admin/ledger/settings is
 * requireAdmin, so reading the gate from there would 403 the very card a
 * finance or executive viewer is promised, and `DryRunReport.pdfGate` only
 * exists once a dry run has been read. The settings route keeps its own
 * admin-only block (with `stampedBy`).
 *
 * NO TOKEN VALUE AND NO FULL REALM ID leaves here — the realm is masked,
 * and the token columns are never selected at all.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['finance', 'executive']);
  if (auth.error) return auth.error;

  const service = createServiceClient();
  const configured = qboConfigured();

  const { data, error } = await service
    .from('quickbooks_tokens')
    .select('realm_id, environment, company_name, access_expires_at, refresh_expires_at, needs_reauth_at, last_error, capabilities')
    .eq('id', 1)
    .maybeSingle();
  if (error) {
    // "We could not ask" is not "not connected" — say which (R7-1).
    return NextResponse.json(
      { error: `Could not read the QuickBooks connection: ${error.message}`, configured },
      { status: 503 },
    );
  }

  let pdfGate: Record<string, unknown>;
  try {
    const gate = await ledgerPdfsEnabled(service);
    const settings = await readLedgerSettings(service);
    pdfGate = {
      enabled: gate.enabled,
      reason: gate.reason,
      via: gate.via,
      stampedAt: settings.pdfs_enabled_at ?? null,
      ...(gate.readError ? { readError: gate.readError } : {}),
    };
  } catch (e: any) {
    pdfGate = { enabled: false, reason: `Could not read the gate — ${String(e?.message || e).slice(0, 200)}`, via: null, stampedAt: null };
  }

  if (!data) {
    return NextResponse.json({
      connected: false,
      configured,
      environment: configured ? qboConfig().environment : null,
      companyName: null,
      realmMasked: null,
      accessExpiresAt: null,
      refreshExpiresAt: null,
      needsReauth: false,
      lastError: null,
      capabilities: {},
      pdfGate,
    });
  }

  return NextResponse.json({
    connected: true,
    configured,
    companyName: data.company_name ?? null,
    realmMasked: maskRealm(String(data.realm_id)),
    environment: data.environment,
    accessExpiresAt: data.access_expires_at,
    refreshExpiresAt: data.refresh_expires_at,
    needsReauth: !!data.needs_reauth_at,
    lastError: data.last_error ?? null,
    capabilities: data.capabilities ?? {},
    pdfGate,
  });
}
