import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const MAX_PER_GROUP = 5;

export async function GET(req: NextRequest) {
  // Staff only. This route runs on the service-role client (bypasses RLS) and
  // returns company-wide data — POs, estimates, customers, invoices; a bare
  // requireAuth let any approved login, including customer/installer accounts,
  // read all of it.
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const q = req.nextUrl.searchParams.get('q')?.trim();
  if (!q || q.length < 2) {
    return NextResponse.json({ results: {} });
  }

  const like = `%${q}%`;

  // Caller-ID search (audit Stage 1: no phone search existed anywhere).
  // A phone-shaped query — digits with phone punctuation only — searches
  // the digit-stripped phone_digits columns (migrations 238/239) so
  // "(555) 123-4567", "555.123.4567" and a bare "5551234567" all match
  // regardless of how the number was stored. The name/email predicates are
  // skipped for these queries: a phone-shaped string isn't a name, and its
  // parens/commas would corrupt the .or() filter syntax anyway.
  const qDigits = q.replace(/\D/g, '');
  const phoneLike = qDigits.length >= 4 && /^[\d\s\-().+/#*]+$/.test(q);

  // Private-message search is scoped to conversations the caller participates
  // in — the service-role query would otherwise expose every staff member's
  // DMs to every other staff member (a full-text extraction oracle). A sentinel
  // id keeps the `.in(...)` well-formed when the caller has no conversations.
  const callerId = auth.user.id;
  const { data: myConvos } = await supabase
    .from('conversations')
    .select('id')
    .or(`participant_1.eq.${callerId},participant_2.eq.${callerId}`);
  const myConvoIds = (myConvos || []).map((c: any) => c.id);
  const scopedConvoIds = myConvoIds.length ? myConvoIds : ['00000000-0000-0000-0000-000000000000'];

  // Run all searches in parallel
  const [pos, vehicles, graphicsJobs, estimates, parts, customers, messages, quotes, poInvoices, jobInvoices, scanInvoices] = await Promise.all([
    // Purchase Orders — search by PO number, customer, line item part numbers
    supabase
      .from('purchase_orders')
      .select('id, po_number, customer, status, ordered_date, created_at, ship_to, po_line_items(id, part_number, description, quantity, unit_price, installed)', { count: 'exact' })
      .or(`po_number.ilike.${like},customer.ilike.${like}`)
      .order('created_at', { ascending: false })
      .limit(MAX_PER_GROUP),

    // Fleet Check-ins — search by VIN, make/model, customer, sales order
    supabase
      .from('fleet_checkins')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, vehicle_trim, customer_name, sales_order_number, status, created_at', { count: 'exact' })
      .or(`vin.ilike.${like},vehicle_make.ilike.${like},vehicle_model.ilike.${like},customer_name.ilike.${like},sales_order_number.ilike.${like}`)
      .order('created_at', { ascending: false })
      .limit(MAX_PER_GROUP),

    // Graphics Jobs — search by job number, title, part number, customer
    supabase
      .from('graphics_jobs')
      .select('id, job_number, title, part_number, customer, status, priority, due_date, created_at', { count: 'exact' })
      .or(`job_number.ilike.${like},title.ilike.${like},part_number.ilike.${like},customer.ilike.${like}`)
      .order('created_at', { ascending: false })
      .limit(MAX_PER_GROUP),

    // Estimates — search by either estimate number (FleetSuite's own and
    // NetSuite's, since staff may have written down either), customer, title
    supabase
      .from('estimates')
      .select('id, estimate_number, netsuite_estimate_number, customer_id, title, status, total, created_at', { count: 'exact' })
      .or(`estimate_number.ilike.${like},netsuite_estimate_number.ilike.${like},title.ilike.${like}`)
      .order('created_at', { ascending: false })
      .limit(MAX_PER_GROUP),

    // Parts Catalog — search the unified catalog by part number, name, customer
    supabase
      .from('netsuite_parts')
      .select('id, item_number, display_name, billable_customer, vehicle_type, graphic_package, sales_price, catalog', { count: 'exact' })
      .eq('is_active', true)
      .or(`item_number.ilike.${like},display_name.ilike.${like},billable_customer.ilike.${like},vehicle_type.ilike.${like},graphic_package.ilike.${like}`)
      .limit(MAX_PER_GROUP * 4),

    // Customers — search by company name, contact, email; phone-shaped
    // queries match the record's phone digits instead (see phoneLike above)
    phoneLike
      ? supabase
          .from('prospects')
          .select('id, company_name, contact_name, email, phone, netsuite_id', { count: 'exact' })
          .like('phone_digits', `%${qDigits}%`)
          .order('company_name')
          .limit(MAX_PER_GROUP)
      : supabase
          .from('prospects')
          .select('id, company_name, contact_name, email, phone, netsuite_id', { count: 'exact' })
          .or(`company_name.ilike.${like},contact_name.ilike.${like},email.ilike.${like}`)
          .order('company_name')
          .limit(MAX_PER_GROUP),

    // Messages — search by body text, scoped to the caller's own conversations
    supabase
      .from('messages')
      .select('id, conversation_id, sender_id, body, created_at', { count: 'exact' })
      .in('conversation_id', scopedConvoIds)
      .ilike('body', like)
      .order('created_at', { ascending: false })
      .limit(MAX_PER_GROUP),

    // Quotes — search by quote number, customer, vehicle description
    supabase
      .from('wrap_quotes')
      .select('id, quote_number, customer, vehicle_description, status, total, created_at', { count: 'exact' })
      .or(`quote_number.ilike.${like},customer->>name.ilike.${like},vehicle_description.ilike.${like}`)
      .order('created_at', { ascending: false })
      .limit(MAX_PER_GROUP),

    // Invoices live in NetSuite; the app references them from three places.
    // Search all three by invoice number and merge below.
    supabase
      .from('po_invoices')
      .select('id, netsuite_invoice_id, netsuite_invoice_number, created_at, purchase_orders(id, po_number, customer)')
      .ilike('netsuite_invoice_number', like)
      .order('created_at', { ascending: false })
      .limit(MAX_PER_GROUP),
    supabase
      .from('graphics_jobs')
      .select('id, title, customer, netsuite_invoice_id, netsuite_invoice_number, invoiced_at')
      .ilike('netsuite_invoice_number', like)
      .limit(MAX_PER_GROUP),
    supabase
      .from('scan_logs')
      .select('invoice_number, billable_customer, po_number, date_invoiced')
      .ilike('invoice_number', like)
      .limit(MAX_PER_GROUP * 10),
  ]);

  // Also search PO line items by part number (separate query since we need the PO context)
  const { data: poLineMatches } = await supabase
    .from('po_line_items')
    .select('id, po_id, part_number, description, quantity, unit_price')
    .ilike('part_number', like)
    .limit(MAX_PER_GROUP);

  // If we got line item matches, fetch their parent POs (deduplicated)
  let poFromLineItems: any[] = [];
  if (poLineMatches && poLineMatches.length > 0) {
    const poIds = [...new Set(poLineMatches.map(l => l.po_id))];
    // Filter out POs we already have from the direct search
    const existingPoIds = new Set((pos.data || []).map((p: any) => p.id));
    const newPoIds = poIds.filter(id => !existingPoIds.has(id));
    if (newPoIds.length > 0) {
      const { data: additionalPOs } = await supabase
        .from('purchase_orders')
        .select('id, po_number, customer, status, ordered_date, created_at, ship_to, po_line_items(id, part_number, description, quantity, unit_price, installed)')
        .in('id', newPoIds)
        .limit(MAX_PER_GROUP);
      poFromLineItems = additionalPOs || [];
    }
  }

  // Merge PO results
  const allPOs = [...(pos.data || []), ...poFromLineItems].slice(0, MAX_PER_GROUP);

  // Phone hits beyond the prospect's own number: a CONTACT's cell is often
  // the number on caller ID, and a NetSuite-mirror customer may have no CRM
  // row at all until a sync backfills it. Both fold into the customers
  // group — contacts mapped to their parent record, mirror rows under the
  // ns-<id> pseudo id the record page already serves.
  const customerRows: any[] = [...(customers.data || [])];
  let customerCount = customers.count ?? customerRows.length;
  if (phoneLike) {
    const [contactHits, mirrorHits] = await Promise.all([
      supabase
        .from('prospect_contacts')
        .select('name, phone, prospect_id, prospects(id, company_name, email, phone, netsuite_id)')
        .like('phone_digits', `%${qDigits}%`)
        .limit(MAX_PER_GROUP),
      supabase
        .from('customers')
        .select('id, company_name, email, phone, netsuite_id')
        .like('phone_digits', `%${qDigits}%`)
        .limit(MAX_PER_GROUP),
    ]);
    const seenProspects = new Set(customerRows.map((r: any) => r.id));
    const seenNs = new Set(customerRows.map((r: any) => r.netsuite_id).filter(Boolean).map(String));
    for (const c of contactHits.data || []) {
      const p = (c as any).prospects;
      if (!p || seenProspects.has(p.id)) continue;
      seenProspects.add(p.id);
      if (p.netsuite_id) seenNs.add(String(p.netsuite_id));
      customerRows.push({
        id: p.id, company_name: p.company_name, contact_name: (c as any).name,
        email: p.email, phone: (c as any).phone || p.phone, netsuite_id: p.netsuite_id,
      });
    }
    for (const m of mirrorHits.data || []) {
      if (!m.netsuite_id || seenNs.has(String(m.netsuite_id))) continue;
      seenNs.add(String(m.netsuite_id));
      customerRows.push({
        id: `ns-${m.netsuite_id}`, company_name: m.company_name, contact_name: null,
        email: m.email, phone: m.phone, netsuite_id: m.netsuite_id,
      });
    }
    customerCount = Math.max(customerCount, customerRows.length);
  }

  // Also search estimates by customer name through the prospects/customers table
  let estimatesByCustomer: any[] = [];
  if (customerRows.length > 0) {
    // Prospects that came from NetSuite have netsuite_id which maps to customers.netsuite_id → estimates.customer_id
    const nsIds = customerRows.filter((c: any) => c.netsuite_id).map((c: any) => c.netsuite_id);
    if (nsIds.length > 0) {
      // Look up the old customer IDs by netsuite_id
      const { data: oldCustomers } = await supabase.from('customers').select('id').in('netsuite_id', nsIds);
      const customerIds = (oldCustomers || []).map((c: any) => c.id);
      if (customerIds.length > 0) {
        const { data: custEstimates } = await supabase
          .from('estimates')
          .select('id, estimate_number, netsuite_estimate_number, customer_id, title, status, total, created_at')
          .in('customer_id', customerIds)
          .order('created_at', { ascending: false })
          .limit(MAX_PER_GROUP);

        const existingEstIds = new Set((estimates.data || []).map((e: any) => e.id));
        estimatesByCustomer = (custEstimates || []).filter((e: any) => !existingEstIds.has(e.id));
      }
    }
  }

  const allEstimates = [...(estimates.data || []), ...estimatesByCustomer].slice(0, MAX_PER_GROUP);

  // Merge invoice references, deduped by invoice number. PO links carry the
  // most context so they win; graphics jobs next; bare scan batches last.
  const invoiceItems: any[] = [];
  const seenInvoices = new Set<string>();
  for (const r of (poInvoices.data || []) as any[]) {
    const num = r.netsuite_invoice_number || String(r.netsuite_invoice_id || '');
    if (!num || seenInvoices.has(num)) continue;
    seenInvoices.add(num);
    invoiceItems.push({
      id: `poinv-${r.id}`, invoice_number: num, netsuite_invoice_id: r.netsuite_invoice_id,
      customer: r.purchase_orders?.customer || null, source: 'po',
      po_id: r.purchase_orders?.id || null, po_number: r.purchase_orders?.po_number || null,
      date: r.created_at,
    });
  }
  for (const j of (jobInvoices.data || []) as any[]) {
    const num = j.netsuite_invoice_number || String(j.netsuite_invoice_id || '');
    if (!num || seenInvoices.has(num)) continue;
    seenInvoices.add(num);
    invoiceItems.push({
      id: `gfxinv-${j.id}`, invoice_number: num, netsuite_invoice_id: j.netsuite_invoice_id,
      customer: j.customer || null, source: 'graphics',
      job_id: j.id, job_title: j.title || null,
      date: j.invoiced_at,
    });
  }
  for (const s of (scanInvoices.data || []) as any[]) {
    const num = s.invoice_number;
    if (!num || seenInvoices.has(num)) continue;
    seenInvoices.add(num);
    invoiceItems.push({
      id: `scaninv-${num}`, invoice_number: num,
      customer: s.billable_customer || null, source: 'scans',
      po_number: s.po_number || null,
      date: s.date_invoiced,
    });
  }

  const results: Record<string, any> = {};
  // True match counts per group (the lists themselves stay capped at
  // MAX_PER_GROUP) so the UI can say "showing 5 of 23" and link to the rest.
  // Merged groups (POs, estimates, invoices) report the primary query's
  // count plus the extras the merge actually found — a floor, never a lie.
  const totals: Record<string, number> = {};
  if (invoiceItems.length > 0) {
    results.invoices = invoiceItems.slice(0, MAX_PER_GROUP);
    totals.invoices = invoiceItems.length;
  }

  if (allPOs.length > 0) {
    results.purchase_orders = allPOs;
    totals.purchase_orders = Math.max(allPOs.length, (pos.count ?? 0) + poFromLineItems.length);
  }
  if (vehicles.data?.length) {
    results.vehicles = vehicles.data;
    totals.vehicles = vehicles.count ?? vehicles.data.length;
  }
  if (graphicsJobs.data?.length) {
    results.graphics_jobs = graphicsJobs.data;
    totals.graphics_jobs = graphicsJobs.count ?? graphicsJobs.data.length;
  }
  if (allEstimates.length > 0) {
    results.estimates = allEstimates;
    totals.estimates = Math.max(allEstimates.length, (estimates.count ?? 0) + estimatesByCustomer.length);
  }
  if (parts.data?.length) {
    // Count is raw matching rows (pre-dedupe) — close enough for "of N".
    totals.parts = parts.count ?? parts.data.length;
    // De-dupe by item number (legacy data can carry >1 row per part), then map
    // onto the shape UniversalSearch renders.
    const seen = new Set<string>();
    results.parts = parts.data
      .filter((p: any) => {
        const k = (p.item_number || '').toUpperCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, MAX_PER_GROUP)
      .map((p: any) => ({
        id: p.id,
        catalog: p.catalog,
        part_number: p.item_number,
        display_name: p.display_name,
        price: p.sales_price || 0,
        end_customer: p.billable_customer,
        vehicle_type: p.vehicle_type,
        graphic_package: p.graphic_package,
      }));
  }
  if (customerRows.length) {
    results.customers = customerRows.slice(0, MAX_PER_GROUP * 2);
    totals.customers = customerCount;
  }
  if (messages.data?.length) {
    results.messages = messages.data;
    totals.messages = messages.count ?? messages.data.length;
  }
  if (quotes.data?.length) {
    totals.quotes = quotes.count ?? quotes.data.length;
    // Keep the legacy result shape the search UI renders
    results.quotes = quotes.data.map((q: any) => ({
      id: q.id, quote_number: q.quote_number, customer_name: q.customer?.name || null,
      vehicle_description: q.vehicle_description, status: q.status, total_price: q.total,
      created_at: q.created_at,
    }));
  }

  return NextResponse.json({ results, totals, query: q });
}
