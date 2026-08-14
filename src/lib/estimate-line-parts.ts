/**
 * Enrich estimate line items with their part's customer-facing assets —
 * catalog photo (absolute public URL) and vendor product-page link — for the
 * "enhanced estimate": the approval page, the approval email, and the signed
 * acceptance snapshot all render these, and all three must agree, so they
 * all enrich through this one helper.
 *
 * Server-only: callers pass a service-role Supabase client.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { r2PublicUrl } from './r2';

export interface PartAssetFields {
  /** Absolute public URL of the catalog photo, or null. */
  part_image_url: string | null;
  /** Vendor product-page URL (https only), or null. */
  part_product_url: string | null;
}

/** Only pass through real web URLs — product_url is hand-entered, and this
 *  string lands in an href in customer-facing HTML. */
const safeUrl = (u: string | null | undefined): string | null =>
  u && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;

export async function enrichLinesWithPartAssets<T extends { part_id?: string | null }>(
  service: SupabaseClient,
  lines: T[],
): Promise<(T & PartAssetFields)[]> {
  const ids = [...new Set(lines.map(l => l.part_id).filter(Boolean))] as string[];
  const byId = new Map<string, { image_path: string | null; product_url: string | null }>();
  if (ids.length > 0) {
    const { data } = await service
      .from('netsuite_parts')
      .select('id, image_path, product_url')
      .in('id', ids);
    for (const p of data || []) byId.set(p.id, p);
  }
  return lines.map(l => {
    const p = l.part_id ? byId.get(l.part_id) : null;
    return {
      ...l,
      part_image_url: p?.image_path ? r2PublicUrl('photos', p.image_path) : null,
      part_product_url: safeUrl(p?.product_url),
    };
  });
}
