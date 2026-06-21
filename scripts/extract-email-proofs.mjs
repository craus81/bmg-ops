#!/usr/bin/env node

/**
 * BMG Ops — Email Graphics-Proof Extractor
 *
 * Pulls graphics proofs (PDFs and image-type attachments) out of the Gmail
 * inbox and saves them to a local folder. "Proof" emails are the artwork /
 * mockup / rendering files vendors send for sign-off before a wrap or print
 * run — they arrive as PDFs or photo-based files (jpg/png/tiff/ai/eps/psd).
 *
 * It reuses the SAME Gmail connection the app already uses: the OAuth refresh
 * token stored in Supabase `google_tokens` (see src/lib/google.ts). No new
 * auth setup is needed as long as Gmail is connected in BMG Ops.
 *
 * What it does:
 *   1. Builds a Gmail client from the stored refresh token.
 *   2. Runs a Gmail search tuned to graphics proofs (overridable).
 *   3. Walks every matching message and collects PDF + image attachments,
 *      skipping tiny inline images (e.g. signature logos).
 *   4. Downloads each attachment into an output folder, one subfolder per
 *      email, de-duplicated by content hash and resumable across runs.
 *   5. Writes a manifest.csv summarizing everything pulled.
 *
 * Requires (from .env.local / .env — same vars the app uses):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REDIRECT_URI
 *
 * Usage:
 *   node scripts/extract-email-proofs.mjs                 # default search
 *   node scripts/extract-email-proofs.mjs --after 2026/01/01
 *   node scripts/extract-email-proofs.mjs --out ~/proofs --max 1000
 *   node scripts/extract-email-proofs.mjs --dry-run       # list, download nothing
 *   node scripts/extract-email-proofs.mjs --query 'from:wrapmate.com has:attachment'
 *
 * Options:
 *   --query <gmail>   Full Gmail search string (overrides the default query)
 *   --after <date>    Only messages after this date (Gmail syntax, e.g. 2026/01/01)
 *   --before <date>   Only messages before this date
 *   --out <dir>       Output directory (default: ./proofs-export)
 *   --max <n>         Cap on messages to scan (default: 2000)
 *   --min-bytes <n>   Min size for jpg/png/gif/webp to keep, drops signature
 *                     logos (default: 25000). PDFs and design files are always kept.
 *   --dry-run         Print what would be pulled without downloading
 *
 * Tune the default search without editing code via env vars:
 *   PROOF_SUBJECT_KEYWORDS   default: proof,proofs,artwork,mockup,rendering,decal,wrap
 *   PROOF_SENDERS            default: nextdoor-graphics.com,wrapmate.com,4over.com
 */

import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import dotenv from 'dotenv';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: path.join(root, '.env.local') });
dotenv.config({ path: path.join(root, '.env') });

// ── CLI args ───────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    query: null,
    after: null,
    before: null,
    out: path.join(process.cwd(), 'proofs-export'),
    max: 2000,
    minBytes: 25000,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--query') opts.query = next();
    else if (a === '--after') opts.after = next();
    else if (a === '--before') opts.before = next();
    else if (a === '--out') opts.out = path.resolve(next());
    else if (a === '--max') opts.max = parseInt(next(), 10) || opts.max;
    else if (a === '--min-bytes') opts.minBytes = parseInt(next(), 10) || 0;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else console.warn(`Ignoring unknown argument: ${a}`);
  }
  return opts;
}

// ── Attachment classification ──────────────────────────────────
// Photo-based / print-proof file types. Design-source files and PDFs are kept
// regardless of size; raster images must clear --min-bytes so we don't pull
// email-signature logos and tracking pixels.
const ALWAYS_KEEP_EXT = new Set(['pdf', 'ai', 'eps', 'psd', 'tif', 'tiff', 'svg']);
const RASTER_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'heif']);

function extOf(filename) {
  const m = /\.([a-z0-9]+)$/i.exec(filename || '');
  return m ? m[1].toLowerCase() : '';
}

function isProofAttachment(filename, sizeBytes, minBytes) {
  const ext = extOf(filename);
  if (ALWAYS_KEEP_EXT.has(ext)) return true;
  if (RASTER_EXT.has(ext)) return (sizeBytes || 0) >= minBytes;
  return false;
}

// ── Build the default proof search ─────────────────────────────
function buildDefaultQuery() {
  const keywords = (process.env.PROOF_SUBJECT_KEYWORDS ||
    'proof,proofs,artwork,mockup,rendering,decal,wrap')
    .split(',').map(s => s.trim()).filter(Boolean);
  const senders = (process.env.PROOF_SENDERS ||
    'nextdoor-graphics.com,wrapmate.com,4over.com')
    .split(',').map(s => s.trim()).filter(Boolean);

  const subjectClause = keywords.length ? `subject:(${keywords.join(' OR ')})` : '';
  const senderClause = senders.length ? `from:{${senders.join(' ')}}` : '';
  const signal = [subjectClause, senderClause].filter(Boolean).join(' OR ');

  // has:attachment keeps the noise floor down; the OR group is the proof signal.
  return signal ? `has:attachment (${signal})` : 'has:attachment subject:proof';
}

// ── Gmail client from the app's stored refresh token ───────────
async function getGmailClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
      'Set them in .env.local (same values the app uses).'
    );
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: tokenRow, error } = await supabase
    .from('google_tokens')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !tokenRow) {
    throw new Error(
      'No Google token found in `google_tokens`. Connect Gmail in BMG Ops first ' +
      '(the same connection used for PO auto-import).'
    );
  }

  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials({
    refresh_token: tokenRow.refresh_token,
    access_token: tokenRow.access_token,
    expiry_date: tokenRow.expiry_date ? new Date(tokenRow.expiry_date).getTime() : undefined,
  });

  // Persist refreshed access tokens back to Supabase, mirroring src/lib/google.ts
  // so the app and this script don't fight over a stale token.
  client.on('tokens', async (tokens) => {
    const updates = {};
    if (tokens.access_token) updates.access_token = tokens.access_token;
    if (tokens.expiry_date) updates.expiry_date = new Date(tokens.expiry_date).toISOString();
    if (Object.keys(updates).length > 0) {
      await supabase.from('google_tokens').update(updates).eq('id', tokenRow.id);
    }
  });

  return google.gmail({ version: 'v1', auth: client });
}

// ── Gmail helpers ──────────────────────────────────────────────
function getHeader(message, name) {
  const headers = message.payload?.headers || [];
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

// Walk MIME parts and collect any attachment that looks like a proof.
function collectProofAttachments(message, minBytes) {
  const out = [];
  function walk(part) {
    if (!part) return;
    const filename = part.filename;
    const attachmentId = part.body?.attachmentId;
    const size = part.body?.size || 0;
    if (filename && attachmentId && isProofAttachment(filename, size, minBytes)) {
      out.push({ filename, attachmentId, size });
    }
    if (part.parts) for (const p of part.parts) walk(p);
  }
  walk(message.payload);
  return out;
}

async function listMessageIds(gmail, query, max) {
  const ids = [];
  let pageToken;
  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 200,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const m of res.data.messages || []) ids.push(m.id);
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken && ids.length < max);
  return ids.slice(0, max);
}

// ── Filesystem helpers ─────────────────────────────────────────
function sanitize(s, fallback = 'unknown') {
  const cleaned = (s || '').replace(/[^a-zA-Z0-9._@-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function senderLocalPart(fromHeader) {
  const m = /<([^>]+)>/.exec(fromHeader) || [null, fromHeader];
  const addr = (m[1] || '').trim();
  return sanitize(addr.split('@')[0] || addr, 'sender');
}

function loadState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { done: {} };
  }
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0] + '*/');
    return;
  }

  let query = opts.query || buildDefaultQuery();
  if (opts.after) query += ` after:${opts.after}`;
  if (opts.before) query += ` before:${opts.before}`;

  console.log(`Gmail query: ${query}`);
  console.log(`Output dir:  ${opts.out}${opts.dryRun ? '  (dry run — nothing will be written)' : ''}`);

  const gmail = await getGmailClient();

  const messageIds = await listMessageIds(gmail, query, opts.max);
  console.log(`Matched ${messageIds.length} message(s). Scanning for proof attachments...\n`);

  if (!opts.dryRun) await fsp.mkdir(opts.out, { recursive: true });
  const stateFile = path.join(opts.out, '.proof-export-state.json');
  const state = opts.dryRun ? { done: {} } : loadState(stateFile);

  const manifestRows = [];
  const stats = { messages: 0, withProofs: 0, downloaded: 0, skipped: 0, errors: 0, bytes: 0 };

  for (const messageId of messageIds) {
    stats.messages++;
    let message;
    try {
      const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
      message = res.data;
    } catch (err) {
      console.warn(`  ! failed to load message ${messageId}: ${err.message}`);
      stats.errors++;
      continue;
    }

    const attachments = collectProofAttachments(message, opts.minBytes);
    if (attachments.length === 0) continue;
    stats.withProofs++;

    const from = getHeader(message, 'From');
    const subject = getHeader(message, 'Subject') || '(no subject)';
    const dateHeader = getHeader(message, 'Date');
    const dateObj = dateHeader ? new Date(dateHeader) : new Date();
    const dateStr = Number.isNaN(dateObj.getTime())
      ? 'undated'
      : dateObj.toISOString().slice(0, 10);

    const folderName = `${dateStr}__${senderLocalPart(from)}__${messageId.slice(0, 8)}`;
    const destDir = path.join(opts.out, folderName);

    console.log(`• ${dateStr}  ${from}`);
    console.log(`  ${subject}`);

    for (const att of attachments) {
      const key = `${messageId}:${att.attachmentId}`;
      if (state.done[key]) {
        stats.skipped++;
        console.log(`    ↳ ${att.filename} (already exported, skipped)`);
        continue;
      }

      if (opts.dryRun) {
        console.log(`    ↳ ${att.filename} (${(att.size / 1024).toFixed(0)} KB)`);
        manifestRows.push({ dateStr, from, subject, filename: att.filename, size: att.size, path: '(dry-run)', messageId });
        continue;
      }

      try {
        const res = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId,
          id: att.attachmentId,
        });
        const b64 = (res.data.data || '').replace(/-/g, '+').replace(/_/g, '/');
        const buffer = Buffer.from(b64, 'base64');

        await fsp.mkdir(destDir, { recursive: true });
        // Prefix with a short content hash so same-named files from one email
        // (e.g. two "proof.pdf"s) never clobber each other.
        const hash = createHash('sha1').update(buffer).digest('hex').slice(0, 8);
        const safeName = sanitize(att.filename, 'attachment');
        const destPath = path.join(destDir, `${hash}__${safeName}`);

        await fsp.writeFile(destPath, buffer);
        state.done[key] = true;
        stats.downloaded++;
        stats.bytes += buffer.length;
        console.log(`    ↳ saved ${att.filename} (${(buffer.length / 1024).toFixed(0)} KB)`);
        manifestRows.push({
          dateStr, from, subject,
          filename: att.filename, size: buffer.length,
          path: path.relative(opts.out, destPath), messageId,
        });
      } catch (err) {
        console.warn(`    ! failed to download ${att.filename}: ${err.message}`);
        stats.errors++;
      }
    }
  }

  if (!opts.dryRun) {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

    const header = ['date', 'from', 'subject', 'filename', 'size_bytes', 'saved_path', 'message_id'];
    const lines = [header.join(',')];
    for (const r of manifestRows) {
      lines.push([r.dateStr, r.from, r.subject, r.filename, r.size, r.path, r.messageId].map(csvCell).join(','));
    }
    fs.writeFileSync(path.join(opts.out, 'manifest.csv'), lines.join('\n') + '\n');
  }

  console.log(
    `\nDone. Scanned ${stats.messages} message(s), ${stats.withProofs} had proof attachments.\n` +
    `Downloaded ${stats.downloaded} file(s) (${(stats.bytes / 1024 / 1024).toFixed(1)} MB), ` +
    `${stats.skipped} already-exported skipped, ${stats.errors} error(s).`
  );
  if (!opts.dryRun) {
    console.log(`Files in: ${opts.out}`);
    console.log(`Manifest: ${path.join(opts.out, 'manifest.csv')}`);
  }
}

main().catch((err) => {
  console.error(`\nProof extraction failed: ${err.message}`);
  process.exit(1);
});
