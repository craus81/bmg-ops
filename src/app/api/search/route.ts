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
  const [pos, vehicles, graphicsJobs, estimates, parts, customers, messages, quotes] = await Promise.all([
    // Purchase Orders — search by PO number, customer, line item part numbers
    supabase
      .from('purchase_orders')
      .select('id, po_number, customer, status, ordered_date, created_at, ship_to, po_line_items(id, part_number, description, quantity, unit_price)')
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

    // Parts Catalog — search by part number, description, customer
    supabase
      .from('catalog')
      .select('id, part_number, customer, end_customer, vehicle_type, graphic_package, price')
      .eq('active', true)
      .or(`part_number.ilike.${like},end_customer.ilike.${like},vehicle_type.ilike.${like},graphic_package.ilike.${like}`)
      .limit(MAX_PER_GROUP),

    // Customers — search by company name or entity ID
    supabase
      .from('customers')
      .select('id, company_name, entity_id, netsuite_id')
      .or(`company_name.ilike.${like},entity_id.ilike.${like}`)
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
      .from('quotes')
      .select('id, quote_number, customer_name, vehicle_description, status, total_price, created_at')
      .or(`quote_number.ilike.${like},customer_name.ilike.${like},vehicle_description.ilike.${like}`)
      .order('created_at', { ascending: false })
      .limit(MAX_PER_GROUP),
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
        .select('id, po_number, customer, status, ordered_date, created_at, ship_to, po_line_items(id, part_number, description, quantity, unit_price)')
        .in('id', newPoIds)
        .limit(MAX_PER_GROUP);
      poFromLineItems = additionalPOs || [];
    }
  }

  // Merge PO results
  const allPOs = [...(pos.data || []), ...poFromLineItems].slice(0, MAX_PER_GROUP);

  // Also search estimates by customer name through the customers table
  let estimatesByCustomer: any[] = [];
  if (customers.data && customers.data.length > 0) {
    const customerIds = customers.data.map((c: any) => c.id);
    const { data: custEstimates } = await supabase
      .from('estimates')
      .select('id, estimate_number, customer_id, title, status, total, created_at')
      .in('customer_id', customerIds)
      .order('created_at', { ascending: false })
      .limit(MAX_PER_GROUP);

    // Filter out already-found estimates
    const existingEstIds = new Set((estimates.data || []).map((e: any) => e.id));
    estimatesByCustomer = (custEstimates || []).filter((e: any) => !existingEstIds.has(e.id));
  }

  const allEstimates = [...(estimates.data || []), ...estimatesByCustomer].slice(0, MAX_PER_GROUP);

  const results: Record<string, any> = {};

  if (allPOs.length > 0) results.purchase_orders = allPOs;
  if (vehicles.data?.length) results.vehicles = vehicles.data;
  if (graphicsJobs.data?.length) results.graphics_jobs = graphicsJobs.data;
  if (allEstimates.length > 0) results.estimates = allEstimates;
  if (parts.data?.length) results.parts = parts.data;
  if (customers.data?.length) results.customers = customers.data;
  if (messages.data?.length) results.messages = messages.data;
  if (quotes.data?.length) results.quotes = quotes.data;

  return NextResponse.json({ results, query: q });
}
