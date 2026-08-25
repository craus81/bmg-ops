/**
 * Wrap-quote adapter for the shared quote-document renderer — builds the
 * QuoteDocModel for BOTH wrap surfaces (the emailed quote and the frozen
 * signed snapshot), replacing the two hand-rolled renderers that used to
 * duplicate every row producer.
 *
 * Wrap formatting conventions live HERE and only here (see the renderer's
 * header): money uses locale thousands separators; tax_rate is a PERCENT
 * rendered raw; a null unit_price is MEANINGFUL (roll-nested shape rows
 * carry sizes only, priced via per-film Material rows) and renders '—',
 * never $0.00.
 */

import { escHtml, type QuoteDocModel, type QuoteDocRow, type QuoteDocTotalRow } from './quote-document';

const money = (n: any) =>
  (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface WrapDocOptions {
  /** Show the pricing block (totals) — the email's `pricing` flag; the
   *  snapshot always prices. */
  pricing: boolean;
  /** Show the line table. Emails AND this with pricing; snapshots honor
   *  hide_line_items. */
  lineItems: boolean;
  /** Coverage diagram URL to embed (emails only — snapshots must not
   *  reference the mutable R2 object). */
  diagramUrl?: string | null;
  /** 'Your quote is attached as a PDF.' note (netsuite-pdf sends). */
  pdfAttachedNote?: boolean;
}

export function wrapDocTitle(pricing: boolean, netsuitePdf: boolean): string {
  return pricing || netsuitePdf ? 'Wrap Quote' : 'Wrap Coverage';
}

export function wrapQuoteDocModel(quote: any, opts: WrapDocOptions): QuoteDocModel {
  const cust = quote.customer || {};
  const rows: QuoteDocRow[] = [];

  // Kit-quantity jobs: the measurement lines price ONE kit; a bold rollup
  // row shows kits × per-kit materials, and the totals block shows the
  // quantity discount / shop minimum that produced the final subtotal.
  // Roll-nested quotes instead price materials as vinyl cut off each film's
  // roll: the shape lines carry no prices (sizes only, unit_price null) and
  // per-film "Material" rows carry the roll totals.
  const adj = quote.adjustments || null;
  const kits = Math.max(1, parseInt(quote.package_qty, 10) || 1);
  const nest = quote.nesting?.enabled ? quote.nesting : null;

  const detailSpan = (text: string) => ` <span style="color:#6b7280;font-size:11px;">${text}</span>`;

  for (const l of quote.measurements || []) {
    const detail = `${money(l.billed_area_sqft)} ft²${l.substrate?.name ? ` · ${escHtml(l.substrate.name)}` : ''}${kits > 1 ? ' · per kit' : ''}`;
    rows.push({
      itemHtml: `${escHtml(l.name)}${detailSpan(detail)}`,
      qtyHtml: escHtml(String(l.qty || 1)),
      rateHtml: l.unit_price == null ? '—' : `$${money(l.unit_price)}`,
      totalHtml: l.line_total == null ? '—' : `$${money(l.line_total)}`,
    });
  }
  if (nest) {
    for (const f of nest.films || []) {
      if (!((parseFloat(f.material_total) || 0) > 0.005)) continue;
      const usedIn = (f.rolls || []).reduce((s: number, r: any) => s + (parseFloat(r.used_length_in) || 0), 0);
      const extra = parseFloat(f.extra_area_sqft) || 0;
      const detail = [
        (parseFloat(f.roll_sqft) || 0) > 0.005 ? `${money(f.roll_sqft)} ft² · ${(usedIn / 12).toFixed(1)} ft of ${money(nest.roll_width_in)}&quot; roll` : '',
        extra > 0.005 ? `${money(extra)} ft² billed by area` : '',
      ].filter(Boolean).join(' + ') + ((nest.sets || 1) > 1 ? ` · ${nest.sets} sets` : '');
      rows.push({
        itemHtml: `<b>Material — ${escHtml(f.label)}</b>${detailSpan(detail)}`,
        qtyHtml: '1',
        rateHtml: `$${money(f.material_total)}`,
        totalHtml: `<b>$${money(f.material_total)}</b>`,
      });
    }
  }
  if (kits > 1 && adj && !nest) {
    rows.push({
      itemHtml: `<b>Materials — ${kits} kits</b>${detailSpan(`${money(adj.kit_area_sqft)} ft² per kit`)}`,
      qtyHtml: `<b>${kits}</b>`,
      rateHtml: `$${money(adj.kit_materials)}`,
      totalHtml: `<b>$${money(adj.pre_materials)}</b>`,
    });
  }
  for (const f of quote.labor?.films || []) {
    if (!(parseFloat(f.total) || 0)) continue;
    rows.push({
      itemHtml: `Install — ${escHtml(f.label)}${detailSpan(`${money(f.sqft)} ft² @ $${money(f.rate)}/ft²`)}`,
      qtyHtml: '1',
      rateHtml: `$${money(f.total)}`,
      totalHtml: `$${money(f.total)}`,
    });
  }
  const laborLabels: Record<string, string> = { design: 'Design', preparation: 'Preparation', installation: 'Installation' };
  for (const key of Object.keys(laborLabels)) {
    const sec = quote.labor?.[key];
    if (!sec || !(parseFloat(sec.total) || 0)) continue;
    rows.push({
      itemHtml: laborLabels[key],
      qtyHtml: '1',
      rateHtml: `$${money(sec.total)}`,
      totalHtml: `$${money(sec.total)}`,
    });
  }

  const showLineTable = opts.pricing && opts.lineItems;

  let totals: QuoteDocTotalRow[] | null = null;
  if (opts.pricing) {
    totals = [];
    const hasAdj = adj && ((parseFloat(adj.discount_amount) || 0) > 0.005 || (parseFloat(adj.min_bump) || 0) > 0.005);
    if (hasAdj) {
      totals.push({ labelHtml: 'Subtotal before adjustments', valueHtml: `$${money(adj.pre_subtotal)}`, color: '#6b7280' });
    }
    if (adj && (parseFloat(adj.discount_amount) || 0) > 0.005) {
      totals.push({ labelHtml: `Quantity discount (${money(adj.discount_pct)}%)`, valueHtml: `−$${money(adj.discount_amount)}`, color: '#7c3aed' });
    }
    if (adj && (parseFloat(adj.min_bump) || 0) > 0.005) {
      totals.push({ labelHtml: 'Shop minimum', valueHtml: `+$${money(adj.min_bump)}`, color: '#b45309' });
    }
    totals.push({ labelHtml: 'Subtotal', valueHtml: `$${money(quote.subtotal)}` });
    // Wrap tax_rate is a PERCENT — rendered raw, never ×100.
    totals.push({ labelHtml: `Tax (${money(quote.tax_rate)}%)`, valueHtml: `$${money(quote.tax_amount)}` });
    totals.push({ labelHtml: 'Total', valueHtml: `$${money(quote.total)}`, bold: true, color: '#059669' });
  }

  const footnotesHtml: string[] = [];
  if (showLineTable && (quote.labor?.films || []).length) {
    footnotesHtml.push(`<b style="color:#374151;">Film usage:</b> ${(quote.labor.films as any[]).map((f: any) => `${escHtml(f.label)} — ${money(f.sqft)} ft²`).join(' &middot; ')}`);
  }
  if (nest && showLineTable) {
    footnotesHtml.push(`<b style="color:#374151;">Materials priced from nested roll layout:</b> ${money((nest.films || []).reduce((s: number, f: any) => s + (parseFloat(f.roll_sqft) || 0), 0))} ft² of ${money(nest.roll_width_in)}&quot; roll${(nest.sets || 1) > 1 ? ` &middot; ${nest.sets} sets nested together` : ''}`);
  }

  const customerBlockHtml = [
    cust.name, cust.address,
    [cust.city, cust.state, cust.zip].filter(Boolean).join(', '),
    cust.phone, cust.email,
  ].filter(Boolean).map(l => escHtml(l)).join('<br>');

  const identityLinesHtml: string[] = [];
  if (quote.project_type) identityLinesHtml.push(`<b>Project Type:</b> ${escHtml(quote.project_type)}`);
  if (quote.vehicle_description) identityLinesHtml.push(`<b>Vehicle:</b> ${escHtml(quote.vehicle_description)}`);

  return {
    docTitle: wrapDocTitle(opts.pricing, !!opts.pdfAttachedNote),
    subtitleHtml: `${escHtml(quote.quote_number)} · ${escHtml(new Date(quote.created_at || Date.now()).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }))}`,
    customerBlockHtml: customerBlockHtml || null,
    identityLinesHtml,
    noteHtml: opts.pdfAttachedNote && !opts.pricing ? 'Your quote is attached as a PDF.' : null,
    diagram: opts.diagramUrl ? { url: opts.diagramUrl, heading: 'Coverage Areas' } : null,
    columns: showLineTable ? { qty: 'Qty', rate: 'Price' } : null,
    rows: showLineTable ? rows : [],
    totals,
    footnotesHtml,
    sections: quote.project_notes
      ? [{ title: 'Project Notes', bodyHtml: escHtml(quote.project_notes) }]
      : [],
  };
}
