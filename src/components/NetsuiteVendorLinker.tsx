'use client';

import { useState } from 'react';
import { useDialog } from '@/components/DialogProvider';
import NetsuiteVendorSearch, { type NsVendor } from '@/components/NetsuiteVendorSearch';

export interface LinkedVendor {
  companyId: string;
  companyName: string;
  netsuiteVendorId: string;
}

/**
 * Link a FleetSuite installer company to its NetSuite vendor without typing
 * an id: pick the vendor from a live NetSuite search, or create a new one.
 * Both go through /api/cni/create-vendor (admin-only), which saves the link
 * on the company — so a mistyped id (Slight Wraps was saved as 2663 instead
 * of 2763, and every bill failed with a misleading currency error) can't
 * happen here.
 *
 * Pass `companyId` for an existing company; without it the route
 * find-or-creates the company by `companyName` and the caller gets its id
 * back in `onLinked`.
 */
export default function NetsuiteVendorLinker({
  companyId,
  companyName,
  onLinked,
}: {
  companyId?: string | null;
  companyName: string;
  onLinked: (v: LinkedVendor) => void | Promise<void>;
}) {
  const dialog = useDialog();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (payload: Record<string, unknown>, failVerb: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/cni/create-vendor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(companyId ? { companyId } : { name: companyName.trim() }),
          ...payload,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        setError(data.error || `Failed to ${failVerb}`);
      } else if (!data.netsuiteVendorId || data.vendorError) {
        // The company may be saved while the vendor isn't (NetSuite refused
        // the create, or the company is already linked to a different id).
        setError(data.vendorError || `Failed to ${failVerb}`);
      } else {
        await onLinked({
          companyId: data.companyId,
          companyName: data.companyName,
          netsuiteVendorId: String(data.netsuiteVendorId),
        });
      }
    } catch (err: any) {
      setError(err?.message || 'Network error');
    }
    setBusy(false);
  };

  const pick = (v: NsVendor) => submit({
    netsuiteVendorId: v.id,
    // Contact info rides along; the route only fills the company's blanks.
    email: v.email || '',
    phone: v.phone || '',
    address: v.address || null,
  }, 'link the NetSuite vendor');

  const create = async () => {
    const name = companyName.trim();
    if (!name) return;
    const ok = await dialog.confirm(
      `Create a new vendor "${name}" in NetSuite? Search first if they might already be there, so you don't end up with a duplicate vendor.`,
    );
    if (ok) await submit({}, 'create the NetSuite vendor');
  };

  return (
    <div>
      <NetsuiteVendorSearch onSelect={busy ? () => {} : pick} initialQuery={companyName.trim()} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '8px' }}>
        <button
          onClick={create}
          disabled={busy || !companyName.trim()}
          style={{
            padding: '7px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 800,
            background: '#22c55e', color: '#fff', border: 'none',
            cursor: busy ? 'default' : 'pointer', opacity: busy || !companyName.trim() ? 0.6 : 1,
          }}
        >
          + Create &ldquo;{companyName.trim()}&rdquo; in NetSuite
        </button>
        {busy && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Saving…</span>}
      </div>
      {error && (
        <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--error)', marginTop: '6px' }}>{error}</div>
      )}
    </div>
  );
}
