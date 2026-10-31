'use client';

/**
 * Several Client Files in one zip (Craig, 2026-10-16: "a way to download
 * multiple client files from the customer record", both ways: tick files,
 * or a whole folder).
 *
 * Built in the browser, like the Completion Photos zip: each file's link
 * comes from /api/client-files/<id>?format=json (an R2 copy or a 4-hour
 * Dropbox link), the file is fetched straight from there without our
 * cookies, and JSZip packs them. Nothing big passes through a serverless
 * function. On the iPhone app the zip goes to the share sheet (Save to
 * Files, AirDrop, Mail), since a plain download link does nothing there.
 */

import JSZip from 'jszip';
import { apiFetch } from '@/lib/api-client';
import { saveFile } from '@/lib/native-files';

/** Bigger than this and a phone (or a browser tab) runs out of memory building it. */
export const MAX_ZIP_BYTES = 500 * 1024 * 1024;
/** One zip holds at most this many files. */
export const MAX_ZIP_FILES = 500;

export interface ZipEntry {
  id: string;
  name: string;
  size: number;
  /** Path inside the zip; defaults to the file name. */
  zipPath?: string;
}

export interface ZipResult {
  added: number;
  skipped: string[];
}

/** What would stop a zip of these files, or null when it can be made. */
export function zipLimitProblem(files: { size: number }[]): string | null {
  if (files.length === 0) return 'Pick at least one file.';
  if (files.length > MAX_ZIP_FILES) return `That's ${files.length.toLocaleString()} files; one zip holds up to ${MAX_ZIP_FILES}.`;
  const bytes = files.reduce((n, f) => n + (f.size || 0), 0);
  if (bytes > MAX_ZIP_BYTES) return `That's ${Math.round(bytes / 1024 / 1024).toLocaleString()} MB; one zip holds up to ${MAX_ZIP_BYTES / 1024 / 1024} MB. Pick fewer files or a smaller folder.`;
  return null;
}

/** File-system-safe zip name: "ATCO – 2026-10-16.zip". */
export function zipFileName(label: string): string {
  const clean = (label || 'Client files').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Client files';
  return `${clean} – ${new Date().toISOString().slice(0, 10)}.zip`;
}

/** Same name twice in one folder of the zip gets " (2)" before the extension. */
function uniquePath(path: string, used: Set<string>): string {
  if (!used.has(path.toLowerCase())) { used.add(path.toLowerCase()); return path; }
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ''];
  for (let i = 2; ; i++) {
    const p = `${stem} (${i})${ext}`;
    if (!used.has(p.toLowerCase())) { used.add(p.toLowerCase()); return p; }
  }
}

async function fetchOne(f: ZipEntry): Promise<Blob> {
  const res = await apiFetch(`/api/client-files/${f.id}?format=json&disposition=attachment&name=${encodeURIComponent(f.name)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.url) throw new Error(body?.error || `HTTP ${res.status}`);
  const file = await fetch(body.url, { credentials: 'omit' });
  if (!file.ok) throw new Error(`HTTP ${file.status}`);
  return file.blob();
}

/**
 * Fetch the files (3 at a time), zip them and hand the zip to the person.
 * A file that can't be fetched is left out and named in `skipped`.
 */
export async function downloadClientFilesZip(
  files: ZipEntry[],
  label: string,
  onProgress?: (text: string) => void,
): Promise<ZipResult> {
  const problem = zipLimitProblem(files);
  if (problem) throw new Error(problem);

  const zip = new JSZip();
  const used = new Set<string>();
  const skipped: string[] = [];
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const f = files[next++];
      try {
        const blob = await fetchOne(f);
        // Already-compressed files (PDF, JPG, EPS) are stored as is: zipping them again only costs time.
        zip.file(uniquePath(f.zipPath || f.name, used), blob, { binary: true });
      } catch {
        skipped.push(f.name);
      }
      done++;
      onProgress?.(`Getting file ${done} of ${files.length}…`);
    }
  };
  onProgress?.(`Getting file 1 of ${files.length}…`);
  await Promise.all(Array.from({ length: Math.min(3, files.length) }, worker));

  const added = files.length - skipped.length;
  if (added === 0) throw new Error('None of those files could be downloaded. Try again in a moment.');

  onProgress?.('Making the zip…');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  const name = zipFileName(label);
  // JSZip's blob is typed application/zip, so the share sheet knows it.
  await saveFile(blob, name);
  return { added, skipped };
}

