'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { createClient } from '@/lib/supabase-browser';
import CollapsibleCard from '@/components/CollapsibleCard';
import TaxExemptCertFiles from '@/components/TaxExemptCertFiles';
import { certWarning, taxMismatch, MISMATCH_TEXT } from '@/lib/customer-tax-exempt';

interface TaxRow {
  tax_exempt: boolean;
  tax_exempt_cert_number: string | null;
  tax_exempt_expires_at: string | null;
  tax_exempt_source: string | null;
  tax_exempt_changed_at: string | null;
  netsuite_taxable: boolean | null;
}

const cInput: CSSProperties = { width: '100%', padding: '7px 9px', borderRadius: '7px', fontSize: '11.5px', background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-primary)' };
const labelCss: CSSProperties = { fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' };
const note = (color: string): CSSProperties => ({ fontSize: '11.5px', color, lineHeight: 1.45, marginTop: '8px' });

/**
 * The customer page's Sales tax card (owner, 2026-10-22): whether the
 * customer is permanently tax exempt, with the certificate, where the
 * setting came from, and warnings when the certificate has expired or
 * NetSuite disagrees. The same flag the estimate's Edit defaults sets;
 * estimates, Graphics Builder and FleetSuite's own invoices all honor it,
 * and the buttons change Taxable on the NetSuite customer too.
 */
export default function CustomerTaxCard({ page, customerId }: { page: string; customerId: string }) {
  const supabase = createClient();
  const [row, setRow] = useState<TaxRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cert, setCert] = useState('');
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.from('customers')
      .select('tax_exempt, tax_exempt_cert_number, tax_exempt_expires_at, tax_exempt_source, tax_exempt_changed_at, netsuite_taxable')
      .eq('id', customerId).maybeSingle();
    if (e || !data) { setLoadError(e?.message || 'Customer not found'); return; }
    const r = data as TaxRow;
    setRow(r);
    setCert(r.tax_exempt_cert_number || '');
    setExpires(r.tax_exempt_expires_at || '');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is stable per render tree
  }, [customerId]);
  useEffect(() => { load(); }, [load]);

  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.from('customers').update(patch).eq('id', customerId);
    setBusy(false);
    if (e) { setError(`Couldn't save: ${e.message}`); return; }
    await load();
  };

  // Through the server: it changes Taxable on the NetSuite customer first
  // and saves here only if NetSuite took it.
  const setExempt = async (exempt: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/customers/tax-exempt', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId, taxExempt: exempt }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.error || `Couldn't save (HTTP ${res.status}).`);
    } catch (e: any) {
      setError(`Couldn't save: ${e?.message || 'network error'}`);
    }
    setBusy(false);
    await load();
  };
  const certDirty = !!row && (cert.trim() !== (row.tax_exempt_cert_number || '') || expires !== (row.tax_exempt_expires_at || ''));
  const saveCert = () => save({ tax_exempt_cert_number: cert.trim() || null, tax_exempt_expires_at: expires || null });

  const today = new Date().toLocaleDateString('en-CA');
  const warning = row?.tax_exempt ? certWarning(row.tax_exempt_expires_at, today) : null;
  const mismatch = row ? taxMismatch(row) : null;
  const when = row?.tax_exempt_changed_at ? new Date(row.tax_exempt_changed_at).toLocaleDateString() : null;
  const source = !row ? null
    : row.tax_exempt_source === 'netsuite' ? `Copied from NetSuite (Taxable is off there)${when ? ` on ${when}` : ''}.`
      : row.tax_exempt_source === 'staff' ? `Set here by staff${when ? ` on ${when}` : ''}, and in NetSuite too.`
        : null;

  const segBtn = (on: boolean, color: string): CSSProperties => ({
    flex: 1, padding: '9px 10px', borderRadius: '9px', fontSize: '12.5px', fontWeight: 800, cursor: busy ? 'default' : 'pointer',
    border: `1px solid ${on ? color : 'var(--border)'}`, background: on ? `${color}22` : 'var(--subtle-bg)',
    color: on ? color : 'var(--text-secondary)', opacity: busy ? 0.6 : 1,
  });

  return (
    <CollapsibleCard page={page} id="sales-tax" title="Sales tax"
      note={row ? (row.tax_exempt ? 'Tax exempt' : 'Taxed') : undefined}
      extra={certDirty && (
        <button onClick={saveCert} disabled={busy}
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: 700, color: '#22c55e', padding: 0, opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      )}>
      {loadError && <div style={note('#ef4444')}>Couldn&apos;t load sales tax: {loadError}</div>}
      {row && (
        <>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => !row.tax_exempt && setExempt(true)} disabled={busy} style={segBtn(row.tax_exempt, '#22c55e')}>
              {row.tax_exempt ? '✓ ' : ''}Tax exempt
            </button>
            <button onClick={() => row.tax_exempt && setExempt(false)} disabled={busy} style={segBtn(!row.tax_exempt, '#60a5fa')}>
              {!row.tax_exempt ? '✓ ' : ''}Charge sales tax
            </button>
          </div>
          <div style={note('var(--text-muted)')}>
            {row.tax_exempt
              ? 'No sales tax on new estimates, Graphics Builder or FleetSuite invoices for this customer.'
              : 'Parts are taxed at the Settings rate; labor, service and freight are not.'}
            {source && <> {source}</>}
          </div>
          {error && <div style={note('#ef4444')}>{error}</div>}
          {warning && <div style={note(warning.level === 'expired' ? '#ef4444' : '#f59e0b')}>⚠ {warning.text}</div>}
          {mismatch && <div style={note(mismatch === 'netsuite_taxes' ? '#ef4444' : '#f59e0b')}>⚠ {MISMATCH_TEXT[mismatch]}</div>}

          {row.tax_exempt && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '10px' }}>
              <label>
                <div style={labelCss}>Certificate number</div>
                <input value={cert} onChange={e => setCert(e.target.value)} placeholder="e.g. 12-3456789" style={cInput} />
              </label>
              <label>
                <div style={labelCss}>Expires</div>
                <input type="date" value={expires} onChange={e => setExpires(e.target.value)} style={cInput} />
              </label>
            </div>
          )}
          <div style={{ marginTop: '10px' }}>
            <TaxExemptCertFiles customerId={customerId} onUploaded={() => { if (!row.tax_exempt) setExempt(true); }} />
          </div>
        </>
      )}
    </CollapsibleCard>
  );
}
