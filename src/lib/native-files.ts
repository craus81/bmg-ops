// Opening stored files inside the iPhone app.
//
// A target="_blank" link in the Capacitor app is handed to Safari, which has
// no FleetSuite session, so /api/storage/download answers "Unauthorized" and a
// download (the Download all zip) just does nothing in the app's web view.
// In the app we fetch the file ourselves instead and either show it in
// ProofViewer or hand it to the iOS share sheet (Save to Files, AirDrop,
// Print). Computers keep the plain links.

import { storageDownloadUrl } from './storage';
import { createClient } from './supabase-browser';

/**
 * Make sure the session cookie holds a live access token before a plain
 * fetch or link relies on it. apiFetch sends a fresh token in a header, but
 * file links ride on the cookie alone, and the app's web view stops the
 * Supabase refresh timer while the phone is locked or the app is in the
 * background. Open the app an hour later, tap a file, and the cookie's
 * token has expired: the route answers "Unauthorized" (Craig, 2026-10-16,
 * Client Files). getSession() refreshes an expired session and writes it
 * back to the cookie, so the next request carries a good one.
 */
export async function ensureFreshSession(): Promise<void> {
  try {
    await createClient().auth.getSession();
  } catch { /* the request below reports any real sign-in problem */ }
}

export function isNativeApp(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return !!(window as any).Capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
}

const VIEWABLE_EXT = new Set(['pdf', 'ai', 'jpg', 'jpeg', 'png', 'gif', 'webp']);

/** Files ProofViewer can draw: PDFs (and PDF-compatible .ai) and common images. */
export function isViewableInApp(fileName: string, fileType?: string | null): boolean {
  const type = (fileType || '').toLowerCase();
  if (type === 'application/pdf') return true;
  if (type.startsWith('image/') && !/heic|heif|photoshop|postscript|tiff/.test(type)) return true;
  const ext = (fileName.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  return VIEWABLE_EXT.has(ext);
}

/**
 * Download a stored file into memory. Asks the download route for a
 * short-lived R2 link (the request carries the app's session cookie), then
 * fetches that link without credentials so R2's CORS rule applies. Large
 * design files skip the serverless function this way.
 */
export async function fetchStoredFile(
  bucket: string,
  path: string,
  fileName: string,
  fileType?: string | null,
): Promise<File> {
  await ensureFreshSession();
  const res = await fetch(`${storageDownloadUrl(bucket, path, fileName)}&format=json`, { credentials: 'include' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.url) throw new Error(body?.error || `HTTP ${res.status}`);
  const file = await fetch(body.url, { credentials: 'omit' });
  if (!file.ok) throw new Error(`HTTP ${file.status}`);
  const blob = await file.blob();
  return new File([blob], fileName, { type: fileType || blob.type || 'application/octet-stream' });
}

export function canShareFiles(files: File[]): boolean {
  try {
    return typeof navigator !== 'undefined' && !!navigator.canShare && navigator.canShare({ files });
  } catch {
    return false;
  }
}

const EXT_FOR_TYPE: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/zip': 'zip',
  'text/csv': 'csv',
};

/**
 * A file name the phone can open. Files on the iPhone go by the name's
 * ending alone: "Save to Files" on a PDF called just "File" (what a NetSuite
 * invoice opened from a blob: link used to get) saves a blank icon nothing
 * will open (Craig, 2026-10-21). Keeps a name that already has an ending and
 * adds the one its type calls for otherwise; a PDF is told by its first
 * bytes ("%PDF") when the type is missing.
 */
export function withFileExtension(name: string | null | undefined, type?: string | null, head?: Uint8Array | null): string {
  const base = (name || '').trim().replace(/[\\/:*?"<>|]+/g, '-') || 'File';
  if (/\.[a-z0-9]{2,5}$/i.test(base)) return base;
  let ext = EXT_FOR_TYPE[(type || '').split(';')[0].trim().toLowerCase()];
  if (!ext && head && head.length >= 4 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) ext = 'pdf';
  return ext ? `${base}.${ext}` : base;
}

// blob: URLs carry no file name, so a screen that opens one says what it is
// called here, and the app's viewer (NativeLinkHandler) looks it up.
const blobNames = new Map<string, string>();

/** Remember the file name for a blob: URL a screen is about to open. */
export function nameBlobUrl(url: string, name: string | null | undefined): string {
  if (name) blobNames.set(url, name);
  return url;
}

/** The name a screen gave a blob: URL, if any. */
export function blobUrlName(url: string): string | null {
  return blobNames.get(url) ?? null;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
));

/**
 * Show a PDF held in memory in the tab the caller opened inside its click
 * (`w`), or a new one, under its real name.
 *
 *  - In the app the blob goes to the in-app viewer (NativeLinkHandler) as
 *    `name`, so Save keeps it, e.g. Invoice_INV1532.pdf.
 *  - On a computer a bare blob: tab saves as "unknown.pdf" (no browser can
 *    name one), so the tab gets a slim bar with a Save button that does,
 *    over the browser's own PDF view, and a Print button beside it that
 *    prints the PDF itself rather than the page around it (Craig,
 *    2026-10-21: separate, obvious buttons per action).
 *  - Phones and tablets in Safari keep the bare tab: an iframe there shows
 *    only the first page.
 */
export function openPdfBytes(w: Window | null, bytes: BlobPart, name: string | null | undefined): void {
  const fileName = withFileExtension(name, 'application/pdf');
  const url = nameBlobUrl(URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })), fileName);
  const isTouch = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
  if (!w || isNativeApp() || isTouch) {
    if (w) w.location.href = url;
    else window.open(url, '_blank');
    return;
  }
  const n = escapeHtml(fileName);
  try {
    w.document.open();
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${n}</title><style>
      html, body { margin: 0; height: 100%; background: #525659; font-family: -apple-system, Segoe UI, Helvetica, Arial, sans-serif; }
      body { display: flex; flex-direction: column; }
      .bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #1f2937; color: #fff; }
      .name { flex: 1; min-width: 0; font-size: 13px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      a.save, button.print { padding: 7px 14px; border-radius: 8px; background: #2563eb; color: #fff; font: 700 13px -apple-system, Segoe UI, Helvetica, Arial, sans-serif; text-decoration: none; border: 0; cursor: pointer; }
      button.print { background: #fff; color: #1f2937; }
      iframe { flex: 1; border: 0; width: 100%; }
    </style></head><body>
      <div class="bar"><div class="name">${n}</div><button class="print" type="button" onclick="printPdf()">Print</button><a class="save" href="${url}" download="${n}">Save PDF</a></div>
      <iframe id="pdf" src="${url}" title="${n}"></iframe>
      <script>
        function printPdf() {
          var f = document.getElementById('pdf');
          try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) { window.print(); }
        }
      </script>
    </body></html>`);
    w.document.close();
  } catch {
    w.location.href = url;
  }
}
