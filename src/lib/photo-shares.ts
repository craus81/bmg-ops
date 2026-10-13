/**
 * Server-side reads for shared photo links (/shared-photos/<token>).
 *
 * A share pins a set of completion_photos ids (migration 369) behind a
 * random token, so a customer can open and download exactly those photos
 * without a FleetSuite login. The token is the only credential; an expired
 * or unknown one gets nothing.
 */

import { createClient } from '@supabase/supabase-js';
import { numberedFileNames, type CompletionPhotoRow } from './completion-photos';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

export interface SharedPhoto {
  id: string;
  storagePath: string;
  fileName: string;
  takenAt: string | null;
  customerName: string | null;
  vin: string | null;
  vehicle: string | null;
  jobLabel: string | null;
}

export type SharedPhotoSet =
  | { status: 'ok'; title: string | null; createdAt: string; expiresAt: string; photos: SharedPhoto[] }
  | { status: 'expired' }
  | { status: 'not_found' };

export async function loadPhotoShare(token: string): Promise<SharedPhotoSet> {
  if (!TOKEN_RE.test(token || '')) return { status: 'not_found' };

  // Built per call, not at module scope: a module-scope client throws at
  // build time when Supabase env vars are absent.
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: share } = await supabase
    .from('photo_shares')
    .select('photo_ids, title, created_at, expires_at')
    .eq('token', token)
    .maybeSingle();
  if (!share) return { status: 'not_found' };
  if (new Date(share.expires_at).getTime() < Date.now()) return { status: 'expired' };

  const ids: string[] = Array.isArray(share.photo_ids) ? share.photo_ids : [];
  if (ids.length === 0) return { status: 'ok', title: share.title, createdAt: share.created_at, expiresAt: share.expires_at, photos: [] };

  const { data } = await supabase
    .from('completion_photos')
    .select('id, source, storage_path, taken_at, customer_name, vin, vehicle, job_label, record_id')
    .in('id', ids);
  // Keep the order the photos were picked in; a photo deleted since simply drops out.
  const byId = new Map(((data || []) as CompletionPhotoRow[]).map(r => [r.id, r]));
  const rows = ids.map(id => byId.get(id)).filter((r): r is CompletionPhotoRow => !!r);
  const names = numberedFileNames(rows);

  return {
    status: 'ok',
    title: share.title,
    createdAt: share.created_at,
    expiresAt: share.expires_at,
    photos: rows.map((r, i) => ({
      id: r.id,
      storagePath: r.storage_path,
      fileName: names[i],
      takenAt: r.taken_at,
      customerName: r.customer_name,
      vin: r.vin,
      vehicle: r.vehicle,
      jobLabel: r.job_label,
    })),
  };
}
