/**
 * Client Files' two FleetSuite folders (Craig, 2026-10-22, thread "Approval
 * email pictures on the estimate"): every customer gets them, Dropbox
 * folder or not, read straight from FleetSuite's own storage.
 *
 *   From Estimates     one folder per estimate, holding the pictures and
 *                      files added on it (estimate_files)
 *   Completion Photos  one folder per job: shop, outside installer and scan
 *                      photos (the completion_photos view, migration 369)
 *
 * Pure grouping and naming, shared by /api/client-files/fleetsuite and its
 * tests.
 */

import { normalizeCompanyName } from './customer-dupes';

export type FleetSuiteFolderKey = 'estimates' | 'completion';

export const FLEETSUITE_FOLDER_NAMES: Record<FleetSuiteFolderKey, string> = {
  estimates: 'From Estimates',
  completion: 'Completion Photos',
};

/** One file in a FleetSuite folder, ready for a thumbnail grid and PhotoLightbox. */
export interface FsFile {
  id: string;
  name: string;
  isImage: boolean;
  size: number;
  at: string | null;
  /** Same-origin, opens inline (also the thumbnail). */
  url: string;
  downloadUrl: string;
  subtitle: string | null;
  /** Where the file came from in FleetSuite (the estimate or the job). */
  link: string | null;
}

/** One sub-folder: an estimate, or a job's completion photos. */
export interface FsSubFolder {
  key: string;
  name: string;
  files: number;
  bytes: number;
  /** Newest file in it (ISO), for the newest-first order. */
  latest: string | null;
}

export interface EstimateFileGroupRow {
  id: string;
  size_bytes: number | string | null;
  created_at: string | null;
  estimate: { id: string; estimate_number: string | null; netsuite_estimate_number?: string | null } | null;
}

export interface CompletionGroupRow {
  id: string;
  source: string;
  taken_at: string | null;
  vin: string | null;
  vehicle: string | null;
  job_label: string | null;
  record_id: string | null;
}

const newestFirst = (a: FsSubFolder, b: FsSubFolder) =>
  (b.latest || '').localeCompare(a.latest || '') || a.name.localeCompare(b.name, undefined, { numeric: true });

const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

/** "EST-2610-014", with NetSuite's number beside it once it has one. */
export function estimateFolderName(est: { estimate_number: string | null; netsuite_estimate_number?: string | null }): string {
  const fs = (est.estimate_number || '').trim();
  const ns = (est.netsuite_estimate_number || '').trim();
  if (ns && fs && ns !== fs) return `${fs} (${ns})`;
  return fs || ns || 'Estimate';
}

export function groupEstimateFiles(rows: EstimateFileGroupRow[]): FsSubFolder[] {
  const out = new Map<string, FsSubFolder>();
  for (const r of rows) {
    if (!r.estimate) continue;
    let g = out.get(r.estimate.id);
    if (!g) {
      g = { key: r.estimate.id, name: estimateFolderName(r.estimate), files: 0, bytes: 0, latest: null };
      out.set(r.estimate.id, g);
    }
    g.files++;
    g.bytes += Number(r.size_bytes) || 0;
    g.latest = later(g.latest, r.created_at);
  }
  return [...out.values()].sort(newestFirst);
}

/** A job's folder key: the source and its record ("shop:<checkin id>"). */
export function completionJobKey(r: Pick<CompletionGroupRow, 'source' | 'record_id' | 'id'>): string {
  return r.record_id ? `${r.source}:${r.record_id}` : r.id;
}

const fmtDay = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

/** "2026-10-20 · SO 5512 · 2024 Ford Transit · VIN …4821" (the parts it has). */
export function completionFolderName(r: Pick<CompletionGroupRow, 'taken_at' | 'job_label' | 'vehicle' | 'vin'>): string {
  const label = (r.job_label || '').trim();
  const vin = (r.vin || '').trim();
  const parts = [
    fmtDay(r.taken_at),
    label && /^\d+$/.test(label) ? `SO ${label}` : label,
    (r.vehicle || '').trim(),
    vin ? `VIN …${vin.slice(-6).toUpperCase()}` : '',
  ].filter(Boolean);
  return parts.join(' · ') || 'Photos';
}

/** Rows newest first in, one folder per job out; the folder is named from its newest photo. */
export function groupCompletionPhotos(rows: CompletionGroupRow[]): FsSubFolder[] {
  const out = new Map<string, FsSubFolder>();
  for (const r of rows) {
    const key = completionJobKey(r);
    let g = out.get(key);
    if (!g) {
      g = { key, name: completionFolderName(r), files: 0, bytes: 0, latest: null };
      out.set(key, g);
    }
    g.files++;
    g.latest = later(g.latest, r.taken_at);
  }
  return [...out.values()].sort(newestFirst);
}

/**
 * PostgREST or-filter for a customer's completion photos: shop photos carry
 * the customer id; installer and scan photos only a name, matched exactly
 * apart from case and spacing. The name is double-quoted so commas and
 * parentheses in it ("Acme, Inc.") don't break the filter.
 */
export function completionCustomerFilter(customerId: string, companyName: string | null | undefined): string {
  const name = normalizeCompanyName(companyName || '');
  const parts = [`customer_id.eq.${customerId}`];
  if (name) {
    const pattern = name.replace(/[\\%_]/g, '\\$&').replace(/ /g, '%');
    parts.push(`customer_name.ilike."${pattern.replace(/["\\]/g, '\\$&')}"`);
  }
  return parts.join(',');
}

/** The ilike above also lets "Acme  Plumbing" through; this keeps only true matches. */
export function completionRowIsCustomer(
  row: { customer_id?: string | null; customer_name: string | null },
  customerId: string,
  companyName: string | null | undefined,
): boolean {
  if (row.customer_id && row.customer_id === customerId) return true;
  const want = normalizeCompanyName(companyName || '');
  return !!want && normalizeCompanyName(row.customer_name || '') === want;
}
