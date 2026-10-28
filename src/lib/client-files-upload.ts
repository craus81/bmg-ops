// Uploads into Client Files (Craig, 2026-10-28): pictures and PDFs dragged
// in from Files, Finder or Photos, or picked with the Upload button, go into
// the Dropbox client folder that's open. A name that's taken keeps both
// (Dropbox adds "(1)"). The browser sends each file in pieces small enough
// for a Vercel function body; /api/client-files/upload passes them on to a
// Dropbox upload session.

import { dropboxPathPart } from '@/lib/dropbox-path';

/** Each piece the browser sends: under Vercel's ~4.5 MB request body limit. */
export const UPLOAD_PIECE_BYTES = 3.5 * 1024 * 1024;

/** Biggest file the Upload button takes. Print files run to hundreds of MB. */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

/**
 * Where an upload goes in Dropbox: the client folder, the sub-folder open in
 * it ("Chevy Express/PRINT"), then the file name. Null when the sub-folder
 * tries to climb out ("..").
 */
export function uploadTargetPath(folderPathLower: string, sub: string, fileName: string): string | null {
  const parts = sub.split('/').map(s => s.trim()).filter(Boolean);
  if (parts.some(p => p === '.' || p === '..')) return null;
  return [folderPathLower.replace(/\/+$/, ''), ...parts.map(dropboxPathPart), dropboxPathPart(fileName)].join('/');
}

/** The pieces a file of `size` bytes goes up in, as [start, end) byte ranges. */
export function uploadPieces(size: number, piece = UPLOAD_PIECE_BYTES): [number, number][] {
  const out: [number, number][] = [];
  for (let at = 0; at < size; at += piece) out.push([at, Math.min(size, at + piece)]);
  return out.length ? out : [[0, 0]];
}
