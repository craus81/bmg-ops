/**
 * QC fixes (migration 381) — issues a customer's QC team reports on vehicles
 * we finished, through one shared link per customer (/qc/<token>).
 *
 * Owner ask 2026-10-15: replace the monday.com QC fix board with something
 * simpler. The reporter gives the last 6 of the VIN, a VIN photo, issue
 * photos and optional comments; BMG sets a fix-by date, then marks it
 * fixed. Ron and Chaquanna at Masterack (customers.qc_notify_emails) are
 * emailed when an issue is reported (their own team's action). The fixed
 * email is a person's send through the standard compose screen, never
 * automatic.
 *
 * Pure helpers shared by the public routes, the staff routes and the pages
 * (browser-safe: no Node imports — server pieces live in qc-fixes-server.ts).
 */

import { deepLinks } from './deep-links';

export type QcStatus = 'new' | 'scheduled' | 'fixed';
export type QcPhotoKind = 'vin' | 'issue' | 'fix';

/** Photos one report can carry (VIN photo included). */
export const QC_MAX_PHOTOS = 12;
/** One upload, after the browser shrinks it. Under Vercel's 4.5 MB body cap. */
export const QC_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
/** How far back the customer's own link lists reports. */
export const QC_LINK_LOOKBACK_DAYS = 120;

export const QC_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

export function isQcImageType(contentType: string | null | undefined): boolean {
  return QC_IMAGE_TYPES.has((contentType || '').toLowerCase());
}

/**
 * What the reporter typed → the last 6 of a VIN, upper-case. Spaces and
 * dashes are dropped, and a whole VIN pasted in is cut to its last 6.
 * Null when fewer than 6 letters/digits are left.
 */
export function normalizeLast6(input: string | null | undefined): string | null {
  const clean = (input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean.length >= 6 ? clean.slice(-6) : null;
}

export function vehicleLabel(c: { vehicle_year?: string | null; vehicle_make?: string | null; vehicle_model?: string | null; vehicle_trim?: string | null } | null | undefined): string | null {
  if (!c) return null;
  const label = [c.vehicle_year, c.vehicle_make, c.vehicle_model, c.vehicle_trim].map(s => (s || '').trim()).filter(Boolean).join(' ');
  return label || null;
}

export interface QcVinCandidate {
  id: string;
  vin: string;
  vehicle_year?: string | null;
  vehicle_make?: string | null;
  vehicle_model?: string | null;
  vehicle_trim?: string | null;
  created_at?: string | null;
}

/**
 * Pick the vehicle the last 6 means. Check-ins are visits, so one VIN can
 * have several: those collapse to the newest visit. Two DIFFERENT VINs
 * ending the same way is a guess we don't make — no match, and staff see
 * the last 6 alone.
 */
export function pickVinMatch(rows: QcVinCandidate[], last6: string): QcVinCandidate | null {
  const hits = rows.filter(r => (r.vin || '').toUpperCase().endsWith(last6));
  const vins = new Set(hits.map(r => r.vin.toUpperCase()));
  if (vins.size !== 1) return null;
  return [...hits].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
}

export function qcStatusLabel(status: QcStatus): string {
  return status === 'new' ? 'New' : status === 'scheduled' ? 'Scheduled' : 'Fixed';
}

/** Status after a staff edit: a fix-by date schedules a new report; clearing it un-schedules. */
export function statusAfterFixBy(current: QcStatus, fixBy: string | null): QcStatus {
  if (current === 'fixed') return 'fixed';
  return fixBy ? 'scheduled' : 'new';
}

export function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://go.bmgfleet.com').replace(/\/$/, '');
}

export function qcLinkUrl(token: string): string {
  return `${appUrl()}${deepLinks.qcLink(token)}`;
}

/** Public URL of one photo, served through the link's token (works in email). */
export function qcPublicPhotoUrl(token: string, photoId: string): string {
  return `${appUrl()}/api/qc/${encodeURIComponent(token)}/photo/${encodeURIComponent(photoId)}`;
}

export const isUuid = (s: string | null | undefined) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || '');

export function fmtQcDate(isoOrDate: string | null | undefined): string {
  if (!isoOrDate) return '';
  const d = new Date(isoOrDate.length === 10 ? `${isoOrDate}T12:00:00` : isoOrDate);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' });
}

