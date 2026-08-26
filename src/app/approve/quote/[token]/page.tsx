'use client';

/**
 * Public wrap-quote approval page — magic-link, no login. The approval
 * machinery (state machine, agreement + accept/reject actions, terminal
 * screens) lives in ApprovalPageShell, shared with /approve/estimate and
 * /approve/proof; this file renders only the wrap-quote document body.
 * This URL must live forever: 30-day tokens are in the wild.
 */

import ApprovalPageShell, { ApprovalHeader, Row } from '@/components/ApprovalPageShell';

const money = (n: any) => (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function QuoteApprovalPage() {
  return (
    <ApprovalPageShell
      kind="quote"
      noun="quote"
      copy={{ expired: 'This approval link has expired. Please ask BMG Fleet Installations to re-send the quote.' }}
      parsePayload={json => json.quote}
      docLabel={q => q?.quote_number ? `Wrap Quote ${q.quote_number}` : null}
      acceptedAt={q => q?.accepted_at || null}
      renderDocument={q => <QuoteDocument q={q} />}
    />
  );
}

function QuoteDocument({ q }: { q: any }) {
  const laborLabels: Record<string, string> = { design: 'Design', preparation: 'Preparation', installation: 'Installation' };

  return (
    <>
      <ApprovalHeader title={`Wrap Quote ${q.quote_number}`}>
        {q.vehicle_description && <div style={{ fontSize: '14px', color: '#475569', marginTop: '2px' }}>{q.vehicle_description}</div>}
        <div style={{ fontSize: '12px', color: '#64748b', marginTop: '6px' }}>
          For {q.customer_name || 'customer'}{q.project_type ? ` · ${q.project_type}` : ''}
        </div>
      </ApprovalHeader>

      {q.diagram_url && (
        <div style={{ marginBottom: '16px', border: '1px solid #e2e8f0', borderRadius: '12px', overflow: 'hidden', background: '#fff' }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- external R2 image, unknown dimensions */}
          <img src={q.diagram_url} alt="Wrap coverage diagram" style={{ width: '100%', display: 'block' }} />
        </div>
      )}

      <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', marginBottom: '16px' }}>
        {/* Sent as "picture + total": line data never left the server, so
            render just the money block below. */}
        {!q.hide_line_items && <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#64748b', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              <th style={{ paddingBottom: '8px' }}>Item</th>
              <th style={{ paddingBottom: '8px', textAlign: 'right' }}>Qty</th>
              <th style={{ paddingBottom: '8px', textAlign: 'right' }}>Price</th>
              <th style={{ paddingBottom: '8px', textAlign: 'right' }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {(q.measurements || []).map((m: any, i: number) => (
              <tr key={i} style={{ borderTop: '1px solid #e2e8f0' }}>
                <td style={{ padding: '8px 0', color: '#0f172a' }}>
                  <div style={{ fontWeight: 600 }}>{m.name}</div>
                  <div style={{ fontSize: '12px', color: '#475569' }}>
                    {money(m.billed_area_sqft)} ft²{m.substrate_name ? ` · ${m.substrate_name}` : ''}{(q.package_qty || 1) > 1 ? ' · per kit' : ''}
                  </div>
                </td>
                <td style={{ padding: '8px 0', textAlign: 'right' }}>{m.qty || 1}</td>
                <td style={{ padding: '8px 0', textAlign: 'right' }}>{m.unit_price == null ? '—' : `$${money(m.unit_price)}`}</td>
                <td style={{ padding: '8px 0', textAlign: 'right' }}>{m.line_total == null ? '—' : `$${money(m.line_total)}`}</td>
              </tr>
            ))}
            {/* Roll-nested quotes: materials bill as vinyl cut off each
                film's roll — the shape rows above show sizes only. */}
            {q.nesting?.enabled && (q.nesting.films || []).filter((f: any) => (parseFloat(f.material_total) || 0) > 0.005).map((f: any, i: number) => (
              <tr key={`roll-${i}`} style={{ borderTop: '1px solid #e2e8f0' }}>
                <td style={{ padding: '8px 0', color: '#0f172a' }}>
                  <div style={{ fontWeight: 700 }}>Material — {f.label}</div>
                  <div style={{ fontSize: '12px', color: '#475569' }}>
                    {[
                      (parseFloat(f.roll_sqft) || 0) > 0.005 ? `${money(f.roll_sqft)} ft² · ${(((f.rolls || []).reduce((s: number, r: any) => s + (parseFloat(r.used_length_in) || 0), 0)) / 12).toFixed(1)} ft of ${money(q.nesting.roll_width_in)}" roll` : '',
                      (parseFloat(f.extra_area_sqft) || 0) > 0.005 ? `${money(f.extra_area_sqft)} ft² billed by area` : '',
                    ].filter(Boolean).join(' + ')}{(q.nesting.sets || 1) > 1 ? ` · ${q.nesting.sets} sets` : ''}
                  </div>
                </td>
                <td style={{ padding: '8px 0', textAlign: 'right' }}>1</td>
                <td style={{ padding: '8px 0', textAlign: 'right' }}>${money(f.material_total)}</td>
                <td style={{ padding: '8px 0', textAlign: 'right', fontWeight: 700 }}>${money(f.material_total)}</td>
              </tr>
            ))}
            {(q.package_qty || 1) > 1 && q.adjustments && !q.nesting?.enabled && (
              <tr style={{ borderTop: '1px solid #e2e8f0' }}>
                <td style={{ padding: '8px 0', color: '#0f172a' }}>
                  <div style={{ fontWeight: 700 }}>Materials — {q.package_qty} kits</div>
                  <div style={{ fontSize: '12px', color: '#475569' }}>{money(q.adjustments.kit_area_sqft)} ft² per kit</div>
                </td>
                <td style={{ padding: '8px 0', textAlign: 'right', fontWeight: 700 }}>{q.package_qty}</td>
                <td style={{ padding: '8px 0', textAlign: 'right' }}>${money(q.adjustments.kit_materials)}</td>
                <td style={{ padding: '8px 0', textAlign: 'right', fontWeight: 700 }}>${money(q.adjustments.pre_materials)}</td>
              </tr>
            )}
            {(q.labor?.films || []).filter((f: any) => (parseFloat(f.total) || 0) > 0).map((f: any) => (
              <tr key={`film-${f.id}`} style={{ borderTop: '1px solid #e2e8f0' }}>
                <td style={{ padding: '8px 0', color: '#0f172a' }}>
                  <div style={{ fontWeight: 600 }}>Install — {f.label}</div>
                  <div style={{ fontSize: '12px', color: '#475569' }}>{money(f.sqft)} ft² @ ${money(f.rate)}/ft²</div>
                </td>
                <td style={{ padding: '8px 0', textAlign: 'right' }}>1</td>
                <td style={{ padding: '8px 0', textAlign: 'right' }}>${money(f.total)}</td>
                <td style={{ padding: '8px 0', textAlign: 'right' }}>${money(f.total)}</td>
              </tr>
            ))}
            {Object.keys(laborLabels).map(k => {
              const sec = q.labor?.[k];
              if (!sec || !(parseFloat(sec.total) || 0)) return null;
              return (
                <tr key={k} style={{ borderTop: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '8px 0', color: '#0f172a', fontWeight: 600 }}>{laborLabels[k]}</td>
                  <td style={{ padding: '8px 0', textAlign: 'right' }}>1</td>
                  <td style={{ padding: '8px 0', textAlign: 'right' }}>${money(sec.total)}</td>
                  <td style={{ padding: '8px 0', textAlign: 'right' }}>${money(sec.total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>}
        <div style={{ borderTop: q.hide_line_items ? 'none' : '2px solid #cbd5e1', marginTop: q.hide_line_items ? 0 : '10px', paddingTop: q.hide_line_items ? 0 : '10px', fontSize: '13px', color: '#0f172a' }}>
          {q.adjustments && ((parseFloat(q.adjustments.discount_amount) || 0) > 0.005 || (parseFloat(q.adjustments.min_bump) || 0) > 0.005) && (
            <Row label="Subtotal before adjustments" value={`$${money(q.adjustments.pre_subtotal)}`} />
          )}
          {q.adjustments && (parseFloat(q.adjustments.discount_amount) || 0) > 0.005 && (
            <Row label={`Quantity discount (${money(q.adjustments.discount_pct)}%)`} value={`−$${money(q.adjustments.discount_amount)}`} />
          )}
          {q.adjustments && (parseFloat(q.adjustments.min_bump) || 0) > 0.005 && (
            <Row label="Shop minimum" value={`+$${money(q.adjustments.min_bump)}`} />
          )}
          <Row label="Subtotal" value={`$${money(q.subtotal)}`} />
          <Row label={`Tax (${money(q.tax_rate)}%)`} value={`$${money(q.tax_amount)}`} />
          <Row label="Total" value={`$${money(q.total)}`} bold />
        </div>
      </div>

      {q.project_notes && (
        <div style={{ marginTop: '14px', padding: '12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>Project Notes</div>
          <div style={{ fontSize: '13px', color: '#0f172a', whiteSpace: 'pre-wrap' }}>{q.project_notes}</div>
        </div>
      )}
    </>
  );
}
