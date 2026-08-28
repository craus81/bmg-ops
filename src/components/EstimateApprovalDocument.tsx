'use client';

/**
 * The estimate document the customer reviews on the approval page — the
 * line table, totals, install/contact/notes sections and the vinyl summary.
 *
 * Shared, not duplicated: /approve/estimate/[token] renders it for the
 * customer beneath ApprovalPageShell's accept/reject card, and the staff
 * preview (/estimates/[id]/approval-preview) renders the same component
 * read-only. Staff never hold the approval token, so a preview that
 * re-implemented the document could silently drift from what was sent.
 */

import { ApprovalHeader, Row, Section } from '@/components/ApprovalPageShell';
import ZoomableImage from '@/components/ZoomableImage';

export default function EstimateApprovalDocument({ estimate: est, lines, graphics }: { estimate: any; lines: any[]; graphics: any[] }) {
  const subtotal = lines.reduce((s: number, l: any) => s + (l.line_total || l.unit_price * l.quantity || 0), 0);

  return (
    <>
      <ApprovalHeader title={`Estimate #${est.estimate_number}`}>
        {est.title && <div style={{ fontSize: '14px', color: '#475569', marginTop: '2px' }}>{est.title}</div>}
        <div style={{ fontSize: '12px', color: '#64748b', marginTop: '6px' }}>For {est.customer_name || 'customer'}</div>
        {/* Vehicle identity — the emailed document shows it, so the page the
            customer approves on must identify the same vehicle. */}
        {(est.vehicle_year || est.vehicle_other || est.vin || est.unit_number) && (
          <div style={{ fontSize: '12px', color: '#334155', marginTop: '4px', fontWeight: 600 }}>
            {[
              [est.vehicle_year, est.vehicle_other].filter(Boolean).join(' '),
              est.vin ? `VIN ${est.vin}` : '',
              est.unit_number ? `Unit ${est.unit_number}` : '',
            ].filter(Boolean).join(' · ')}
          </div>
        )}
        {(est.po_number || est.expiration_date) && (
          <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
            {[est.po_number ? `PO #${est.po_number}` : '', est.expiration_date ? `Expires ${est.expiration_date}` : ''].filter(Boolean).join(' · ')}
          </div>
        )}
      </ApprovalHeader>

      <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', marginBottom: '16px' }}>
        {/* Lines are a CSS grid, not a table: the money columns are what the
            customer is approving, so they must never be squeezed or pushed
            off-screen. On phones each line stacks (see .appr-line). */}
        <div>
          <div
            className="appr-line appr-line-head"
            style={{ color: '#64748b', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', paddingBottom: '8px' }}
          >
            <div>Item</div>
            <div className="appr-num">Qty</div>
            <div className="appr-num">Rate</div>
            <div className="appr-num">Total</div>
          </div>
          {lines.map((l: any) => (
            <div
              key={l.id}
              className="appr-line"
              style={{ borderTop: '1px solid #e2e8f0', padding: '8px 0', fontSize: '13px', color: '#0f172a' }}
            >
              <div className="appr-c-item" style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                {l.image_url && (
                  <ZoomableImage
                    src={l.image_url}
                    alt={l.item_number || 'Product'}
                    wrapStyle={{ flexShrink: 0 }}
                    style={{ width: '56px', height: '56px', objectFit: 'cover', borderRadius: '6px', border: '1px solid #e2e8f0' }}
                  />
                )}
                {/* overflowWrap: a long SKU or URL must break rather than
                    widen the row past the card. */}
                <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  <div style={{ fontWeight: 600 }}>{l.item_number || l.description || 'Item'}</div>
                  {l.description && l.description !== l.item_number && (
                    <div style={{ fontSize: '12px', color: '#475569' }}>{l.description}</div>
                  )}
                  {l.notes && <div style={{ fontSize: '11px', color: '#94a3b8', fontStyle: 'italic' }}>{l.notes}</div>}
                  {l.product_url && (
                    <a
                      href={l.product_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: '11px', color: '#2563eb', textDecoration: 'underline' }}
                    >View product ↗</a>
                  )}
                </div>
              </div>
              <div className="appr-c-qty appr-num">
                <span className="appr-cell-label">Qty</span>{l.quantity}
              </div>
              <div className="appr-c-rate appr-num">
                <span className="appr-cell-label">Rate</span>${Number(l.unit_price || 0).toFixed(2)}
              </div>
              <div className="appr-c-total appr-num" style={{ fontWeight: 600 }}>
                <span className="appr-cell-label">Total</span>${Number(l.line_total || (l.unit_price || 0) * (l.quantity || 0)).toFixed(2)}
              </div>
            </div>
          ))}
        </div>
        <div style={{ borderTop: '2px solid #cbd5e1', marginTop: '10px', paddingTop: '10px', fontSize: '13px', color: '#0f172a' }}>
          <Row label="Subtotal" value={`$${subtotal.toFixed(2)}`} />
          {est.labor_total > 0 && <Row label={`Labor (${est.labor_hours_override ?? est.labor_hours} hrs @ $${est.labor_rate}/hr)`} value={`$${Number(est.labor_total).toFixed(2)}`} />}
          {!est.tax_exempt && est.tax_amount > 0 && <Row label={`Tax (${(est.tax_rate * 100).toFixed(2)}%)`} value={`$${Number(est.tax_amount).toFixed(2)}`} />}
          <Row label="Total" value={`$${Number(est.grand_total).toFixed(2)}`} bold />
        </div>
      </div>

      {est.install_instructions && (
        <Section title="Install Instructions">{est.install_instructions}</Section>
      )}
      {(est.on_site_contact_name || est.on_site_contact_phone) && (
        <Section title="On-site Contact">
          {est.on_site_contact_name}{est.on_site_contact_phone && ` · ${est.on_site_contact_phone}`}
        </Section>
      )}
      {est.delivery_preferences && <Section title="Delivery">{est.delivery_preferences}</Section>}
      {est.notes && <Section title="Notes">{est.notes}</Section>}

      {/* Vinyl / Graphics — the wrap content the customer is approving
          (same summaries the emailed PDF and the frozen snapshot carry). */}
      {graphics.map((g: any) => (
        <div key={g.quoteNumber} style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', marginTop: '14px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>
            Vinyl / Graphics
          </div>
          <div style={{ fontSize: '13px', fontWeight: 700, color: '#0f172a' }}>
            Quote {g.quoteNumber}{g.vehicle ? ` — ${g.vehicle}` : ''}{g.totalSqft > 0 ? ` · ~${Math.round(g.totalSqft)} sqft coverage` : ''}
          </div>
          {(g.films || []).length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: '18px', fontSize: '13px', color: '#334155' }}>
              {g.films.map((f: any, i: number) => (
                <li key={i} style={{ marginTop: '2px' }}>{f.name}{f.areas?.length > 0 ? ` — ${f.areas.join(', ')}` : ''}</li>
              ))}
            </ul>
          )}
          {g.diagramUrl && (
            <ZoomableImage
              src={g.diagramUrl}
              alt={`Coverage diagram — Quote ${g.quoteNumber}`}
              wrapStyle={{ marginTop: '10px' }}
              style={{ maxWidth: '100%', border: '1px solid #e2e8f0', borderRadius: '8px' }}
            />
          )}
        </div>
      ))}
    </>
  );
}
