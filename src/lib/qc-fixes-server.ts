/**
 * Server-side reads/writes for QC fixes (migration 381) shared by the public
 * link routes (/api/qc/[token]/…) and the staff routes (/api/qc-fixes/…).
 */

import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { r2PresignGet, r2Upload } from './r2';
import { renderSignatureHtml, type EmailSignature } from './email-signature';
import { fmtQcDate, isUuid, pickVinMatch, vehicleLabel, type QcPhotoKind } from './qc-fixes';

type Service = SupabaseClient<any, any, any>;

export interface QcCustomer {
  id: string;
  company_name: string | null;
  qc_token: string;
  qc_notify_emails: string[];
}

/** The customer a QC link token belongs to, or null (bad, revoked or regenerated link). */
export async function resolveQcCustomer(service: Service, token: string): Promise<QcCustomer | null> {
  const t = (token || '').trim();
  if (!isUuid(t)) return null;
  const { data } = await service
    .from('customers')
    .select('id, company_name, qc_token, qc_notify_emails')
    .eq('qc_token', t)
    .maybeSingle();
  if (!data?.qc_token) return null;
  return { ...data, qc_notify_emails: data.qc_notify_emails || [] } as QcCustomer;
}

/** The vehicle a last-6 points at: newest visit of the one VIN ending that way. */
export async function matchVinLast6(service: Service, last6: string) {
  const { data } = await service
    .from('fleet_checkins')
    .select('id, vin, vehicle_year, vehicle_make, vehicle_model, vehicle_trim, created_at')
    .ilike('vin', `%${last6}`)
    .order('created_at', { ascending: false })
    .order('id')
    .limit(20);
  const hit = pickVinMatch((data || []) as any[], last6);
  if (!hit) return null;
  return { checkinId: hit.id, vin: hit.vin.toUpperCase(), label: vehicleLabel(hit) };
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };

/** Store one photo in R2 (prefix 'photos') and record it. */
export async function saveQcPhoto(service: Service, opts: {
  customerId: string;
  reportId: string | null;
  kind: QcPhotoKind;
  bytes: Buffer;
  contentType: string;
  fileName: string;
  uploadedBy?: string | null;
}): Promise<{ id: string } | { error: string }> {
  const ct = opts.contentType.toLowerCase();
  const path = `qc-fixes/${opts.customerId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${EXT[ct] || 'jpg'}`;
  const up = await r2Upload('photos', path, opts.bytes, ct);
  if (!up.success) return { error: 'Could not store the photo. Try again.' };
  const { data, error } = await service.from('qc_fix_photos').insert({
    report_id: opts.reportId,
    customer_id: opts.customerId,
    kind: opts.kind,
    storage_path: path,
    file_name: (opts.fileName || `photo.${EXT[ct] || 'jpg'}`).slice(0, 200),
    content_type: ct,
    size_bytes: opts.bytes.byteLength,
    uploaded_by: opts.uploadedBy || null,
  }).select('id').single();
  if (error || !data) return { error: error?.message || 'Could not record the photo' };
  return { id: data.id };
}

/** Short-lived signed URL for one stored photo. */
export function qcPhotoSignedUrl(photo: { storage_path: string; file_name: string }, download = false): Promise<string> {
  return r2PresignGet('photos', photo.storage_path, {
    filename: photo.file_name,
    disposition: download ? 'attachment' : 'inline',
    expiresIn: 3600,
  });
}

/**
 * The customer's QC link token, minting one when none exists (or always,
 * with `regenerate` — the old link must stop working).
 */
export async function ensureQcLink(
  service: SupabaseClient<any, any, any>,
  customer: { id: string; qc_token?: string | null; qc_token_created_at?: string | null },
  opts: { regenerate?: boolean } = {},
): Promise<{ token: string; createdAt: string; changed: boolean }> {
  if (customer.qc_token && !opts.regenerate) {
    return { token: customer.qc_token, createdAt: customer.qc_token_created_at || new Date().toISOString(), changed: false };
  }
  const token = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const { error } = await service
    .from('customers')
    .update({ qc_token: token, qc_token_created_at: createdAt })
    .eq('id', customer.id);
  if (error) throw new Error(`Could not save the QC link: ${error.message}`);
  return { token, createdAt, changed: true };
}

const esc = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface QcEmailReport {
  vin_last6: string;
  vin?: string | null;
  vehicle_label?: string | null;
  reported_by_name: string;
  comments?: string | null;
  created_at: string;
  fix_by?: string | null;
  fixed_at?: string | null;
}

function photoStrip(urls: string[]): string {
  if (!urls.length) return '';
  return `<div style="margin:16px 0 4px;">${urls.map(u =>
    `<a href="${esc(u)}" style="display:inline-block;margin:0 8px 8px 0;"><img src="${esc(u)}" alt="Photo" width="170" style="width:170px;height:128px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb;display:block;"></a>`,
  ).join('')}</div>`;
}

function detailsTable(r: QcEmailReport, extra: Array<[string, string]>): string {
  const vehicle = r.vehicle_label ? ` (${esc(r.vehicle_label)})` : '';
  const rows: Array<[string, string]> = [
    ['VIN', `<b>…${esc(r.vin_last6)}</b>${vehicle}`],
    ['Reported', `${esc(fmtQcDate(r.created_at))} by ${esc(r.reported_by_name)}`],
    ...(r.comments ? [['Comments', esc(r.comments).replace(/\n/g, '<br>')] as [string, string]] : []),
    ...extra,
  ];
  return `<table style="border-collapse:collapse;font-size:14px;color:#1a2b36;">${rows.map(([k, v]) =>
    `<tr><td style="padding:4px 14px 4px 0;color:#6b7280;vertical-align:top;white-space:nowrap;">${k}</td><td style="padding:4px 0;">${v}</td></tr>`,
  ).join('')}</table>`;
}

function shell(inner: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:24px;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">${inner}</div>
    <div style="text-align:center;padding:14px;font-size:11px;color:#9ca3af;">BMG Fleet Installations · QC fixes</div>
  </div>
</body>
</html>`;
}

function button(url: string, label: string): string {
  return `<div style="margin:20px 0 4px;"><a href="${esc(url)}" style="display:inline-block;background:#1e4a5e;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:12px 22px;border-radius:8px;">${esc(label)}</a></div>`;
}

/** The email Ron and Chaquanna get the moment their team reports an issue. */
export function buildQcReportedEmail(opts: {
  customerName: string;
  report: QcEmailReport;
  photoUrls: string[];
  linkUrl: string;
}): { subject: string; html: string } {
  const r = opts.report;
  const subject = `QC fix reported: VIN …${r.vin_last6}`;
  const html = shell(`
      <div style="font-size:18px;font-weight:800;color:#1a2b36;margin-bottom:12px;">New QC fix reported</div>
      ${detailsTable(r, [])}
      ${photoStrip(opts.photoUrls)}
      ${button(opts.linkUrl, 'View the report')}
      <div style="font-size:12px;color:#6b7280;margin-top:10px;">BMG has it. You'll see the fix-by date on the link once it's scheduled.</div>`);
  return { subject, html };
}

/** The fixed email, composed and sent by a person (compose screen preview + send). */
export function buildQcFixedEmail(opts: {
  report: QcEmailReport;
  message: string;
  fixedOn: string;
  fixPhotoUrls: string[];
  linkUrl: string;
  signature: EmailSignature | null;
}): { subject: string; html: string } {
  const r = opts.report;
  const subject = `QC fix done: VIN …${r.vin_last6}`;
  const html = shell(`
      <div style="font-size:18px;font-weight:800;color:#166534;margin-bottom:12px;">✓ QC fix done</div>
      ${opts.message ? `<div style="font-size:14px;color:#374151;white-space:pre-wrap;line-height:1.6;margin-bottom:14px;">${esc(opts.message)}</div>` : ''}
      ${detailsTable(r, [['Fixed', `<b>${esc(fmtQcDate(opts.fixedOn))}</b>`]])}
      ${photoStrip(opts.fixPhotoUrls)}
      ${button(opts.linkUrl, 'View the report')}
      ${renderSignatureHtml(opts.signature, 'light')}`);
  return { subject, html };
}
