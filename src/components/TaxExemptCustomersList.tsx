'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { fetchAllRows } from '@/lib/fetch-all';
import { deepLinks } from '@/lib/deep-links';
import { certWarning, taxMismatch, MISMATCH_TEXT } from '@/lib/customer-tax-exempt';

interface Row {
  id: string;
  netsuite_id: string | null;
  company_name: string | null;
  tax_exempt: boolean;
  tax_exempt_cert_number: string | null;
  tax_exempt_expires_at: string | null;
  tax_exempt_source: string | null;
  netsuite_taxable: boolean | null;
}

const cell: CSSProperties = { padding: '7px 8px', borderTop: '1px solid var(--border)', fontSize: '12px', verticalAlign: 'top' };

/**
 * Settings → Company: every tax-exempt customer, plus any NetSuite doesn't
 * tax that FleetSuite does, with the certificate and what needs attention
 * (owner, 2026-10-22). Each name opens the customer page's Sales tax card.
 */
export default function TaxExemptCustomersList() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyAttention, setOnlyAttention] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    fetchAllRows<Row>((from, to) => supabase.from('customers')
      .select('id, netsuite_id, company_name, tax_exempt, tax_exempt_cert_number, tax_exempt_expires_at, tax_exempt_source, netsuite_taxable')
      .or('tax_exempt.eq.true,netsuite_taxable.eq.false')
      .order('company_name').order('id')
      .range(from, to))
      .then(({ data, error: e }) => { if (e) setError(e.message); else setRows(data); });
  }, []);

  const today = new Date().toLocaleDateString('en-CA');
  const listed = (rows || []).map(r => {
    const warning = r.tax_exempt ? certWarning(r.tax_exempt_expires_at, today) : null;
    const mismatch = taxMismatch(r);
    return { r, warning, mismatch, attention: !!warning || !!mismatch };
  });
  const attentionCount = listed.filter(x => x.attention).length;
  const shown = onlyAttention ? listed.filter(x => x.attention) : listed;

  return (
    <div>
      <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '4px' }}>Tax-exempt customers</div>
      <div style={{ fontSize: '11px', color: 'var(--text-label)', marginBottom: '10px' }}>
        Customers who pay no sales tax on estimates, Graphics Builder and FleetSuite invoices. Anyone NetSuite has
        Taxable off for is copied here automatically every two hours; change one on the customer&apos;s page under
        Sales tax. An expired certificate only shows a warning.
      </div>
      {error && <div style={{ fontSize: '12px', color: '#ef4444' }}>Couldn&apos;t load the list: {error}</div>}
      {!rows && !error && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</div>}
      {rows && (
        <>
          <div style={{ display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap' }}>
            {[
              { on: !onlyAttention, label: `All · ${listed.length}`, set: false },
              { on: onlyAttention, label: `⚠ Needs attention · ${attentionCount}`, set: true },
            ].map(c => (
              <button key={c.label} onClick={() => setOnlyAttention(c.set)}
                style={{ padding: '5px 10px', borderRadius: '999px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                  border: `1px solid ${c.on ? '#3b82f6' : 'var(--border)'}`, background: c.on ? 'rgba(59,130,246,0.12)' : 'var(--subtle-bg)',
                  color: c.on ? '#3b82f6' : 'var(--text-secondary)' }}>{c.label}</button>
            ))}
          </div>
          {shown.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{onlyAttention ? 'Nothing needs attention.' : 'No tax-exempt customers yet.'}</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ fontSize: '10.5px', color: 'var(--text-muted)', textAlign: 'left' }}>
                    <th style={{ padding: '4px 8px' }}>Customer</th>
                    <th style={{ padding: '4px 8px' }}>Set by</th>
                    <th style={{ padding: '4px 8px' }}>Certificate</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(({ r, warning, mismatch }) => (
                    <tr key={r.id}>
                      <td style={cell}>
                        {r.netsuite_id ? (
                          <a href={deepLinks.customerByNetsuiteId(r.netsuite_id)} style={{ color: '#60a5fa', fontWeight: 700, textDecoration: 'none' }}>
                            {r.company_name || r.netsuite_id}
                          </a>
                        ) : <span style={{ fontWeight: 700 }}>{r.company_name || 'Unnamed'}</span>}
                        {!r.tax_exempt && <span style={{ marginLeft: '6px', fontSize: '10px', fontWeight: 800, color: '#f59e0b' }}>TAXED HERE</span>}
                        {warning && <div style={{ fontSize: '11px', marginTop: '3px', color: warning.level === 'expired' ? '#ef4444' : '#f59e0b' }}>⚠ {warning.text}</div>}
                        {mismatch && <div style={{ fontSize: '11px', marginTop: '3px', color: mismatch === 'netsuite_taxes' ? '#ef4444' : '#f59e0b' }}>⚠ {MISMATCH_TEXT[mismatch]}</div>}
                      </td>
                      <td style={{ ...cell, whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                        {r.tax_exempt_source === 'netsuite' ? 'NetSuite' : r.tax_exempt_source === 'staff' ? 'Staff' : '—'}
                      </td>
                      <td style={{ ...cell, color: 'var(--text-secondary)' }}>
                        {r.tax_exempt_cert_number ? `#${r.tax_exempt_cert_number}` : <span style={{ color: 'var(--text-muted)' }}>No number</span>}
                        {r.tax_exempt_expires_at && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>exp {new Date(`${r.tax_exempt_expires_at}T00:00:00`).toLocaleDateString()}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
