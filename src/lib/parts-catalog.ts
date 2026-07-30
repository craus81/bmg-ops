/**
 * Unified parts catalog helpers (netsuite_parts in CatalogItem shape) —
 * shared by the PO list (imports / catalog matching) and the PO record page
 * (per-line "Add to Catalog"). Extracted from the list page when it became
 * a thin table. Manual (non-NetSuite) parts are created as source='manual'
 * with a NULL netsuite_id so the NetSuite sync never deactivates them.
 */

import type { createClient } from '@/lib/supabase-browser';
import type { CatalogItem } from '@/lib/types';

export const PART_FIELDS =
  'id, item_number, catalog, customer, billable_customer, vehicle_type, graphic_package, sales_price, proof_pages, is_active';

export function partToCatalogItem(p: any): CatalogItem {
  return {
    id: p.id,
    part_number: p.item_number,
    catalog: p.catalog === 'upfit' ? 'upfit' : 'graphics',
    customer: p.customer || '',
    end_customer: p.billable_customer || '',
    vehicle_type: p.vehicle_type || '',
    graphic_package: p.graphic_package || '',
    price: Number(p.sales_price) || 0,
    proof_pages: p.proof_pages ?? 1,
    active: p.is_active !== false,
  };
}

// Find a part by item number (case-insensitive), creating a manual row if it
// doesn't exist yet. Returns it in CatalogItem shape (its id is a part_id).
export async function findOrCreateManualPart(
  supabase: ReturnType<typeof createClient>,
  params: {
    partNumber: string;
    description?: string | null;
    price?: number;
    customer?: string | null;
    billableCustomer?: string | null;
    vehicleType?: string | null;
    graphicPackage?: string | null;
  },
): Promise<CatalogItem | null> {
  const partNumber = (params.partNumber || '').trim();
  if (!partNumber) return null;
  // ilike fetches a case-insensitive superset; narrow to an exact match in JS
  // so wildcard chars in a part number can't cause a false positive.
  const { data: candidates } = await supabase
    .from('netsuite_parts')
    .select(PART_FIELDS)
    .ilike('item_number', partNumber);
  const existing = ((candidates as any[]) || []).find(
    (c) => (c.item_number || '').toUpperCase() === partNumber.toUpperCase(),
  );
  if (existing) return partToCatalogItem(existing);

  const { data: created } = await supabase
    .from('netsuite_parts')
    .insert({
      netsuite_id: null,
      item_number: partNumber,
      display_name: params.description || partNumber,
      description: params.description || null,
      catalog: 'graphics',
      source: 'manual',
      sales_price: params.price || 0,
      customer: params.customer || null,
      billable_customer: params.billableCustomer || null,
      vehicle_type: params.vehicleType || null,
      graphic_package: params.graphicPackage || null,
      is_active: true,
    })
    .select(PART_FIELDS)
    .single();
  return created ? partToCatalogItem(created as any) : null;
}
