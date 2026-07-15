import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const MAX_PER_GROUP = 5;

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const q = req.nextUrl.searchParams.get('q')?.trim();
  if (!q || q.length < 2) {
    return NextResponse.json({ results: {} });
  }

  const like = `%${q}%`;

  // Run all searches in parallel
  const [pos, vehicles, graphicsJobs, estimates, parts, customers, messages, quotes, poInvoices, jobInvoices, scanInvoices] = await Promise.all([
    // Purchase Orders — search by PO number, customer, line item part numbers
    supabase
      .from('purchase_orders')
      .select('id, po_number, customer, status, ordered_date, created_at, ship_to, po_line_items(id, part_number, description, quantity, unit_price, installed)')
      .or(`po_number.ilike.${like},customer.ilike.${like}`)
      .order('created_at', { ascending: false })
      .limit(MAX_PER_GROUP),

    // Fleet Check-ins — search by VIN, make/model, customer, sales order
    supabase
      .from('fleet_checkins')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, vehicle_trim, customer_name, sales_order_number, status, created_at')
      .or(`vin.ilike.${like},vehicle_make.ilike.${like},vehicle_model.ilike.${like},customer_name.ilike.${like},sales_order_number.ilike.${like}`)
      .order('created_at', { ascending: false })
      .limit(MAX_PER_GROUP),

    // Graphics Jobs — search by job number, title, part number, customer
    supabase
      .from('graphics_jobs')
      .select('id, job_number, title, part_number, customer, status, priority, due_date, created_at')
      .or(`job_number.ilike.${like},title.ilike.${like},part_number.ilike.${like},customer.ilike.${like}`)
      .order('created_at', { ascending: false })
      .limit(MAX_PER_GROUP),

    // Estimates — search by estimate number, customer name, title
    supabase
      .from('estimates')
      .select('id, estimate_number, customer_id, title, status, total, created_at')
      .or(`estimate_number.ilike.${like},title.ilike.${like}`)
      .order('created_at', { ascending: false })
      .limit(MAX_PER_GROUP),

    // Parts Catalog — search the unified catalog by part number, name, customer
    supabase
      .from('netsuite_parts')
      .select('id, item_number, display_name, billable_customer, vehicle_type, graphic_package, sales_price, catalog')
      .eq('is_active', true)
      .or(`item_number.ilike.${like},display_name.ilike.${like},billable_customer.ilike.${like},vehicle_type.ilike.${like},graphic_package.ilike.${like}`)
      .limit(MAX_PER_GROUP * 4),

    // Customers & Prospects — search by company name, contact, email
    supabase
      .from('prospects')
      .select('id, company_name, contact_name, email, phone, status, netsuite_id')
      .or(`company_name.ilike.${like},contact_name.ilike.${like},email.ilike.${like}`)
      .order('company_name')
      .limit(MAX_PER_GROUP),

    // Messages — search by body text
    supabase
      .from('messages')
      .select('id, conversation_id, sender_id, body, created_at')
      .ilike('body', like)
      .order('created_at', { ascending: false })
      .limit(MAX_PER_GROUP),

    // Quotes — search by quote number, customer, vehicle description
    supabase
      .from('wrap_quotes')
      .select('id, quote_number, customer, vehicle_description, status, total, created_at')
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

  // Also search estimates by customer name through the prospects/customers table
  let estimatesByCustomer: any[] = [];
  if (customers.data && customers.data.length > 0) {
    // Prospects that came from NetSuite have netsuite_id which maps to customers.netsuite_id → estimates.customer_id
    const nsIds = customers.data.filter((c: any) => c.netsuite_id).map((c: any) => c.netsuite_id);
    if (nsIds.length > 0) {
      // Look up the old customer IDs by netsuite_id
      const { data: oldCustomers } = await supabase.from('customers').select('id').in('netsuite_id', nsIds);
      const customerIds = (oldCustomers || []).map((c: any) => c.id);
      if (customerIds.length > 0) {
        const { data: custEstimates } = await supabase
          .from('estimates')
          .select('id, estimate_number, customer_id, title, status, total, created_at')
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
  if (invoiceItems.length > 0) results.invoices = invoiceItems.slice(0, MAX_PER_GROUP);

  if (allPOs.length > 0) results.purchase_orders = allPOs;
  if (vehicles.data?.length) results.vehicles = vehicles.data;
  if (graphicsJobs.data?.length) results.graphics_jobs = graphicsJobs.data;
  if (allEstimates.length > 0) results.estimates = allEstimates;
  if (parts.data?.length) {
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
  if (customers.data?.length) results.customers = customers.data;
  if (messages.data?.length) results.messages = messages.data;
  if (quotes.data?.length) {
    // Keep the legacy result shape the search UI renders
    results.quotes = quotes.data.map((q: any) => ({
      id: q.id, quote_number: q.quote_number, customer_name: q.customer?.name || null,
      vehicle_description: q.vehicle_description, status: q.status, total_price: q.total,
      created_at: q.created_at,
    }));
  }

  return NextResponse.json({ results, query: q });
}
