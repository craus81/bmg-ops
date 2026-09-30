#!/usr/bin/env node

/**
 * PVO template sync — the nightly, cloud-storage version of pvodownloaderv3.js
 * ===========================================================================
 *
 * Pro Vehicle Outlines caps downloads at 25/day, so this works the same way the
 * browser script did: index the whole catalog once (browsing costs nothing),
 * then take the next 23 templates in priority order every night. The difference
 * is where things live:
 *
 *   files    ->  Cloudflare R2, under vehicle-templates/originals/ and /previews/
 *   index    ->  Supabase: pvo_catalog (the queue) + vehicle_templates (the library)
 *   session  ->  R2 at pvo/session.json (private — outside the WAF allowlist),
 *                with a local copy in ~/.fleetsuite/pvo-session.json
 *
 * PVO logs in through Salesforce SSO. With PVO_EMAIL / PVO_PASSWORD set, the
 * script signs in by itself in headless Chrome whenever the saved session has
 * lapsed; without them, sign in once by hand with --login.
 *
 * ── Where it runs ─────────────────────────────────────────────────────────
 *   Daily from GitHub Actions (.github/workflows/pvo-sync.yml) — no computer
 *   needed. It can still run on a Mac the old way:
 *   node scripts/pvo-sync.mjs --login      # opens Chrome, you log into PVO
 *   node scripts/pvo-sync.mjs --rescan     # indexes the catalog (no downloads used)
 *   node scripts/pvo-sync.mjs              # the daily batch
 *
 * Every run also: skips downloads already taken in the last 20 hours (so a
 * doubled run can't blow the cap), re-indexes the catalog weekly to pick up
 * new templates and fresh download tokens, calibrates each template for the
 * wrap estimator as it lands, and emails a summary to PVO_SUMMARY_EMAIL.
 *
 * ── Options ───────────────────────────────────────────────────────────────
 *   --login          Open a visible browser to sign in, save the session, exit
 *   --rescan         Re-index the PVO catalog before downloading
 *   --limit N        Downloads this run (default 23 — PVO caps at 25, we leave
 *                    2 spare so you can grab one by hand in a hurry)
 *   --format ai      ai | eps | pdf | cel (default ai)
 *   --seed-existing  Mark catalog entries we already have as downloaded
 *   --dry-run        Show what would be downloaded, download nothing
 *   --headful        Run the browser visibly (for debugging)
 *
 * Requires (env or .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME.
 * Optional: PVO_EMAIL + PVO_PASSWORD (unattended sign-in), RESEND_API_KEY +
 * PVO_SUMMARY_EMAIL (daily summary; RESEND_FROM_EMAIL / RESEND_FROM_NAME).
 */

import { chromium } from 'playwright-core';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'path';
import { homedir } from 'os';
import dotenv from 'dotenv';

// Everything resolves from the repo, not the working directory — launchd runs
// this from wherever it likes.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: join(ROOT, '.env.local') });
dotenv.config({ path: join(ROOT, '.env') });

// PVO's hard cap is 25/day. We take 23 and leave 2 in reserve so there is
// always headroom to grab a specific template by hand when a job needs one.
const DEFAULT_LIMIT = 23;

// Downloads taken inside this window count against today's batch. 20h rather
// than 24h so a scheduled run that fires a little earlier than yesterday's
// (GitHub's cron drifts) still gets its full batch, while a second run on the
// same day finds nothing left to take.
const BUDGET_WINDOW_HOURS = 20;

// Re-index the catalog this often: picks up templates PVO has added since and
// refreshes download tokens. Browsing costs no downloads.
const RESCAN_EVERY_DAYS = 7;

// ── Args ──
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };

const LOGIN_MODE = has('--login');
const RESCAN = has('--rescan');
const SEED_EXISTING = has('--seed-existing');
const DRY_RUN = has('--dry-run');
const HEADFUL = has('--headful');
const LIMIT = Math.max(1, Number(val('--limit', String(DEFAULT_LIMIT))) || DEFAULT_LIMIT);
const FORMAT = String(val('--format', 'ai')).toLowerCase();

// ── Config ──
const BASE = 'https://templates.provehicleoutlines.com';
const PROFILE_DIR = join(homedir(), '.fleetsuite', 'pvo-profile');
const STATE_FILE = join(homedir(), '.fleetsuite', 'pvo-session.json');
const PRIORITY_FILE = join(ROOT, 'scripts', 'pvo-priority.txt');
const R2_PREFIX = 'vehicle-templates';
// Deliberately outside vehicle-templates/: the files.bmgfleet.com WAF only
// serves that prefix and photos/parts/, so this key is never public.
const R2_SESSION_KEY = 'pvo/session.json';

const PVO_EMAIL = process.env.PVO_EMAIL || '';
const PVO_PASSWORD = process.env.PVO_PASSWORD || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const SUMMARY_TO = (process.env.PVO_SUMMARY_EMAIL || '').split(',').map((e) => e.trim()).filter(Boolean);
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'notifications@bmgfleet.com';
const FROM_NAME = process.env.RESEND_FROM_NAME || 'FleetSuite';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET_NAME || 'fleetsuite';

if (!LOGIN_MODE) {
  const missing = [];
  if (!SUPABASE_URL) missing.push('NEXT_PUBLIC_SUPABASE_URL');
  if (!SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!R2_ACCOUNT_ID) missing.push('R2_ACCOUNT_ID');
  if (!R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
  if (!R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
  if (missing.length) {
    console.error('ERROR: missing env vars in .env.local: ' + missing.join(', '));
    process.exit(1);
  }
}

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

const r2 = R2_ACCOUNT_ID ? new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
}) : null;

// ── Small helpers ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${stamp()}]`, ...a);

const sanitize = (s) => (s || '')
  .replace(/\u00a0/g, ' ')
  .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
  .replace(/\s+/g, ' ')
  .trim().slice(0, 140) || 'unnamed';

// Same slug shape the ZIP importer uses, so R2 paths stay consistent.
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').slice(0, 80);

// For matching catalog entries against templates we already imported.
const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Longest-first so "Boats - Bass Boats" wins over "Boats - Bass".
const MAKES = ["Acura","Aircraft","Audi","Austin","Backgrounds","BMW","Boats - Bass Boats","Boats - Boat Transom","Boats - Bowrider","Boats - Chriscraft","Boats - Contender","Boats - Cruiser","Boats - Donzi","Boats - Grady-White","Boats - Houseboats","Boats - Javelin","Boats - Johnboat","Boats - Nordic Tug","Boats - Patrol Boat","Boats - PennYann","Boats - Rinker","Boats - Searay","Boats - Searaydr","Boats - Sport","Boats - Stingray","Buick","Bus - ABC","Bus - Atlanta","Bus - Bluebird","Bus - Champion","Bus - Chance","Bus - Classic","Bus - Collins","Bus - Crown","Bus - Eldorado","Bus - Flexible","Bus - Gillig","Bus - GMC","Bus - Goshen","Bus - Krystal","Bus - MCI","Bus - NABI","Bus - Neoplan","Bus - NewFlyer","Bus - Novabus","Bus - Orion","Bus - Prevost","Bus - Rail","Bus - RTS","Bus - School","Bus - Setra","Bus - Startran","Bus - STV","Bus - Terra","Bus - Thomas","Bus - Union","Bus - VanHool","Bus - Volvo","Bus - Worldbus","Cadillac","Chevrolet","Chrysler","Conversion Van","Daewoo","Dennis","Dodge","Eagle","Edsel","Emergency - Ambulance","Emergency - Fire","Fiat","Food Truck","Ford","Freightliner","GEO","GM","GMC","Grumman","Harley-Davidson","HINO","Honda","Hummer","Hyundai","Infiniti","International Navistar","Isuzu","Jaguar","Jeep","Kawasaki","Kenworth","KIA","Land Rover","Lexus","Lincoln","Locomotives","Mack","Mazda","Mercedes Smartcar","Mercedes","Mercury","Mini","Mitsubishi","Navistar Aeromaster","Nissan","Oldsmobile","Peterbilt","Plymouth","Police Interceptor - Chevrolet","Police Interceptor - Ford","Pontiac","Porsche","Quote Templates","Race vehicles","Rivian","RV","Saab","Saturn","Scion","Sign Blanks","Snow machine - Bombardier","Snow machine - Yamaha","Specialty - Bobcat","Specialty - Cobra","Specialty - EZ-Go","Specialty - Limousine","Specialty - Snocat","Specialty - Street sweeper","Specialty - Weinermobile","Specialty - Zamboni Ice machine","Sterling","Subaru","Suzuki","Tesla","Tow Trucks","Toyota","Trailer Featherlite","Trailer Flatbed","Trailer Food","Trailer Haulmark","Trailer Heavy Duty","Trailer Livestock","Trailer Pace","Trailer Snowmobile","Trailer Tanker","Trailer Wells Cargo","Truck Boxes Medium Duty","Unicell","Union City Vans","Utility Truck Boxes","Vicinity","Volkswagen","Volvo","Watercraft - Bombardier Sea-Doo","Watercraft - Kawasaki","Watercraft - Polaris","Watercraft - Tigershark","Watercraft - Yamaha","WesternStar","Wheels","Yamaha"]
  .sort((a, b) => b.length - a.length);

// "2001-2005 Plymouth Voyager" -> { years, make, model, yearStart }
function parseDesc(desc) {
  let years = '', rest = desc;
  const ym = /^(\d{4}(?:-\d{4})?)\s*(.*)$/.exec(desc);
  if (ym) { years = ym[1]; rest = ym[2]; }
  let make = MAKES.find((m) => rest.toLowerCase().indexOf(m.toLowerCase()) === 0);
  const model = make ? rest.slice(make.length).trim() : rest.trim();
  if (!make) make = 'Uncategorized';
  return { years, make, model: model || 'General', yearStart: years ? years.slice(0, 4) : '' };
}

// Priority rank: index of the first list line whose every word is in the
// description. Unmatched templates rank after every line.
function buildMatcher() {
  let text = '';
  try { text = readFileSync(PRIORITY_FILE, 'utf-8'); } catch { /* no list = flat order */ }
  const lines = text.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l[0] !== '#')
    .map((l) => l.toLowerCase().split(/\s+/));
  return {
    count: lines.length,
    rank: (desc) => {
      const d = (desc || '').toLowerCase();
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].every((w) => d.indexOf(w) !== -1)) return i;
      }
      return lines.length;
    },
  };
}

// Supabase caps a select at 1000 rows; page through everything.
async function fetchAll(table, columns, tweak) {
  const out = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    let q = supabase.from(table).select(columns).range(from, from + size - 1);
    if (tweak) q = tweak(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < size) break;
  }
  return out;
}

// ── Browser session ──
async function openBrowser({ headed }) {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: !headed,
    viewport: { width: 1400, height: 950 },
  });
  // Chrome drops session cookies when the browser closes, so we keep our own
  // snapshot and put it back on every run. The R2 copy is the one that
  // matters on GitHub Actions, where every run starts on a fresh machine.
  const state = (await loadSessionFromR2()) || loadSessionFromFile();
  if (state?.cookies?.length) {
    try { await ctx.addCookies(state.cookies); } catch { /* stale shape — sign-in rebuilds it */ }
  }
  return ctx;
}

function loadSessionFromFile() {
  if (!existsSync(STATE_FILE)) return null;
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); } catch { return null; }
}

async function loadSessionFromR2() {
  if (!r2) return null;
  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: R2_SESSION_KEY }));
    return JSON.parse(await res.Body.transformToString());
  } catch { return null; /* first run, or no snapshot yet */ }
}

async function saveSession(ctx) {
  const state = JSON.stringify(await ctx.storageState());
  mkdirSync(join(homedir(), '.fleetsuite'), { recursive: true });
  writeFileSync(STATE_FILE, state, { mode: 0o600 });
  if (r2) {
    try {
      await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET, Key: R2_SESSION_KEY, Body: state, ContentType: 'application/json',
      }));
    } catch (err) {
      log(`Could not save the PVO session to R2 (${err.message}) — next run signs in again.`);
    }
  }
}

// Logged in == /members returns template cards rather than an SSO redirect.
async function isLoggedIn(ctx) {
  const res = await ctx.request.get(`${BASE}/members?page=1`, { timeout: 45000 });
  if (!res.ok()) return false;
  if (/my\.site\.com|loginsalesforce/i.test(res.url())) return false;
  const html = await res.text();
  return /onclick="[^"]*showPreview\(/.test(html) || /download\('/.test(html);
}

// Unattended sign-in through PVO's Salesforce login page. Written against the
// usual Salesforce Experience Cloud forms: one page with username + password,
// or username first and password on the next step. Playwright's CSS locators
// pierce open shadow roots, so Lightning login components work too.
async function autoLogin(ctx, page) {
  if (!PVO_EMAIL || !PVO_PASSWORD) return false;
  log('Signing into PVO...');
  try {
    await page.goto(`${BASE}/members`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    const userBox = page.locator([
      'input[type="email"]', 'input[name="username"]', 'input[id*="username" i]',
      'input[name*="user" i]', 'input[placeholder*="user" i]', 'input[placeholder*="email" i]',
    ].join(', ')).filter({ visible: true }).first();
    const passBox = page.locator('input[type="password"]').filter({ visible: true }).first();
    const submit = page.locator([
      'button[type="submit"]', 'input[type="submit"]', 'button:has-text("Log In")',
      'button:has-text("Login")', 'button:has-text("Sign In")', 'button:has-text("Next")',
      'button:has-text("Continue")',
    ].join(', ')).filter({ visible: true }).first();

    await userBox.waitFor({ state: 'visible', timeout: 30000 });
    await userBox.fill(PVO_EMAIL);
    if (!(await passBox.isVisible().catch(() => false))) {
      await submit.click();
      await passBox.waitFor({ state: 'visible', timeout: 30000 });
    }
    await passBox.fill(PVO_PASSWORD);
    await submit.click();

    // SSO bounces through a few redirects before landing back on PVO.
    const deadline = Date.now() + 90 * 1000;
    while (Date.now() < deadline) {
      await sleep(3000);
      if (await isLoggedIn(ctx)) {
        await saveSession(ctx);
        log('Signed in.');
        return true;
      }
    }
    // Say what the page is asking for (no field values) so a failed run's
    // log points at the fix: a wrong password vs. a verification code.
    const body = ((await page.textContent('body').catch(() => '')) || '').replace(/\s+/g, ' ');
    if (/verif|code|authenticat/i.test(body)) log('PVO asked for a verification code — sign-in needs a person.');
    else if (/password|invalid|incorrect/i.test(body)) log('PVO rejected the email or password.');
    else log(`Sign-in did not finish (ended on ${new URL(page.url()).host}).`);
  } catch (err) {
    log(`Sign-in failed: ${err.message.split('\n')[0]}`);
  }
  return false;
}

async function doLogin() {
  console.log('\nOpening Chrome. Sign into Pro Vehicle Outlines in that window —');
  console.log('this script waits for you and then remembers the session.\n');
  const ctx = await openBrowser({ headed: true });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(`${BASE}/members`, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (await isLoggedIn(ctx)) {
      await saveSession(ctx);
      log(`Signed in. Session saved to ${STATE_FILE}`);
      await ctx.close();
      console.log('\nNext: node scripts/pvo-sync.mjs --rescan\n');
      return;
    }
  }
  await ctx.close();
  console.error('Timed out after 10 minutes without a signed-in session.');
  process.exit(1);
}

// ── Catalog indexing (browsing only — costs no downloads) ──
async function indexCatalog(ctx, page) {
  log('Indexing the PVO catalog (uses no downloads)...');
  const seen = new Map();

  // Stops at the first empty page; the ceiling only guards a runaway loop.
  for (let pageNum = 1; pageNum <= 3000; pageNum++) {
    const res = await ctx.request.get(`${BASE}/members?page=${pageNum}`, { timeout: 45000 });
    if (!res.ok()) { log(`  page ${pageNum}: HTTP ${res.status()} — skipping`); continue; }
    const html = await res.text();

    // Parse in the browser so we reuse the exact selectors the v3 script used.
    const cards = await page.evaluate((h) => {
      const doc = new DOMParser().parseFromString(h, 'text/html');
      const out = [];
      for (const card of doc.querySelectorAll('.card')) {
        const prev = card.querySelector('a[onclick*="showPreview"]');
        const dl = card.querySelector('button[onclick*="download("]');
        const body = card.querySelector('.card-body');
        const idM = /showPreview\((\d+)\)/.exec(prev?.getAttribute('onclick') || '');
        const tokM = /download\('([^']+)'\)/.exec(dl?.getAttribute('onclick') || '');
        if (!idM || !tokM) continue;
        out.push({
          id: idM[1],
          token: tokM[1],
          desc: (body?.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(),
        });
      }
      return out;
    }, html);

    if (!cards.length) break;
    const before = seen.size;
    for (const c of cards) if (!seen.has(c.id)) seen.set(c.id, c);
    // Past the last page some sites repeat the final page instead of going
    // empty — a page with nothing new means we've seen it all.
    if (seen.size === before) break;
    if (pageNum % 10 === 0) log(`  page ${pageNum} — ${seen.size} templates so far`);
    await sleep(300);
  }

  const rows = [...seen.values()].map((c) => {
    const meta = parseDesc(c.desc);
    return {
      pvo_id: c.id,
      token: c.token,
      description: c.desc,
      make: meta.make,
      model: meta.model,
      years: meta.years || null,
      year_start: meta.yearStart || null,
      base_name: sanitize([meta.years, meta.make, meta.model].filter(Boolean).join(' ')),
      updated_at: new Date().toISOString(),
    };
  });

  // Upsert so a rescan refreshes tokens without losing download history.
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('pvo_catalog')
      .upsert(rows.slice(i, i + 500), { onConflict: 'pvo_id', ignoreDuplicates: false });
    if (error) throw new Error(`catalog upsert failed: ${error.message}`);
  }
  log(`Catalog indexed: ${rows.length} templates.`);
  return rows.length;
}

// ── Seed: don't re-download the templates already in vehicle_templates ──
async function seedExisting() {
  const existing = await fetchAll('vehicle_templates', 'id,name');
  const pending = await fetchAll('pvo_catalog', 'pvo_id,base_name,description',
    (q) => q.eq('status', 'pending'));
  if (!existing.length || !pending.length) return 0;

  // The old ZIP import suffixed duplicate names with the PVO id, e.g. "... (3176)".
  const byPvoId = new Map();
  const byName = new Map();
  for (const row of existing) {
    const m = /\((\d+)\)\s*$/.exec(row.name || '');
    if (m) byPvoId.set(m[1], row.id);
    const norm = normalize(row.name);
    if (norm && !byName.has(norm)) byName.set(norm, row.id);
  }

  const updates = [];
  for (const p of pending) {
    let match = byPvoId.get(p.pvo_id);
    if (!match) {
      const target = normalize(p.base_name || p.description);
      if (!target) continue;
      for (const [norm, id] of byName) {
        if (norm.endsWith(target)) { match = id; byName.delete(norm); break; }
      }
    }
    if (match) updates.push({ pvo_id: p.pvo_id, id: match });
  }

  for (const u of updates) {
    await supabase.from('pvo_catalog').update({
      status: 'downloaded',
      vehicle_template_id: u.id,
      downloaded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('pvo_id', u.pvo_id);
  }
  if (updates.length) log(`Seeded ${updates.length} catalog entries from templates already in the library.`);
  return updates.length;
}

// ── R2 ──
async function r2Put(key, body, contentType) {
  await r2.send(new PutObjectCommand({
    Bucket: R2_BUCKET, Key: `${R2_PREFIX}/${key}`, Body: body, ContentType: contentType,
  }));
  return key;
}

const contentTypeFor = (ext) => ({
  ai: 'application/postscript',
  eps: 'application/postscript',
  pdf: 'application/pdf',
  cel: 'application/octet-stream',
}[ext] || 'application/octet-stream');

function extFromDisposition(res, fallback) {
  const cd = res.headers()['content-disposition'] || '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(cd);
  if (m) { const e = m[1].split('.').pop(); if (e && e.length <= 5) return e.toLowerCase(); }
  return fallback;
}

// ── Wrap estimator calibration ──
// The same computeCalibration the ZIP/bulk importers use, loaded straight from
// the app source (Node 22.18+ strips the TypeScript types). If it can't load,
// templates still import and calibrate later from the admin backfill.
let computeCalibration = null;
let parseScaleFactor = null;
try {
  const mod = await import('../src/lib/template-calibration.ts');
  computeCalibration = mod.computeCalibration;
  parseScaleFactor = mod.parseScaleFactor;
} catch (err) {
  log(`Calibration unavailable (${err.message.split('\n')[0]}) — templates import uncalibrated.`);
}

function calibrate(vectorBytes, imageBytes) {
  if (!computeCalibration || !vectorBytes || !imageBytes) return null;
  try {
    return computeCalibration(new Uint8Array(vectorBytes), new Uint8Array(imageBytes), parseScaleFactor('1:20')).pxPerIn;
  } catch { return null; }
}

// Real downloads inside the budget window. file_format is only set by an
// actual download — --seed-existing stamps downloaded_at without it.
async function recentDownloads() {
  const since = new Date(Date.now() - BUDGET_WINDOW_HOURS * 3600 * 1000).toISOString();
  const { count, error } = await supabase.from('pvo_catalog')
    .select('pvo_id', { count: 'exact', head: true })
    .eq('status', 'downloaded').not('file_format', 'is', null).gte('downloaded_at', since);
  if (error) throw new Error(`pvo_catalog count failed: ${error.message}`);
  return count || 0;
}

// ── The nightly batch ──
async function runBatch(ctx) {
  const matcher = buildMatcher();
  const names = [];
  const failures = [];

  const already = DRY_RUN ? 0 : await recentDownloads();
  const budget = Math.max(0, LIMIT - already);
  if (already) log(`${already} downloaded in the last ${BUDGET_WINDOW_HOURS}h — taking ${budget} more this run.`);
  if (!budget) return { downloaded: 0, failed: 0, capHit: false, skipped: 'already ran today', names, failures };

  const queue = await fetchAll('pvo_catalog', 'pvo_id,token,description,make,model,years,year_start,base_name,attempts',
    (q) => q.in('status', ['pending', 'failed']).lt('attempts', 3));
  if (!queue.length) {
    log('Nothing pending — the whole catalog is downloaded.');
    return { downloaded: 0, failed: 0, capHit: false, pending: 0, names, failures };
  }

  const ranked = queue
    .map((row, idx) => ({ row, rank: matcher.rank(row.description), idx }))
    .sort((a, b) => (a.rank - b.rank) || (a.idx - b.idx));
  const onList = ranked.filter((r) => r.rank < matcher.count).length;
  log(`${ranked.length} templates pending (${onList} on the priority list). Taking up to ${budget}.`);

  let downloaded = 0, failed = 0, capHit = false;

  for (const { row, rank } of ranked) {
    if (downloaded >= budget || capHit) break;

    const meta = {
      make: row.make || 'Uncategorized',
      model: row.model || 'General',
      year: row.year_start || '',
    };
    const base = row.base_name || sanitize(row.description);
    const tag = rank < matcher.count ? '[priority] ' : '';

    if (DRY_RUN) { log(`${tag}would download: ${base}`); downloaded++; continue; }

    try {
      const res = await ctx.request.get(
        `${BASE}/members/templates/download/${row.token}?filetype=${FORMAT}`,
        { timeout: 120000 },
      );
      if (!res.ok()) throw new Error(`download request failed (HTTP ${res.status()})`);

      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (ct.includes('text/html')) {
        const text = await res.text();
        if (/download maximum|exceeded/i.test(text)) { capHit = true; break; }
        if (/my\.site\.com|loginsalesforce|name="password"/i.test(text)) {
          throw new Error('SESSION_EXPIRED');
        }
        throw new Error('server returned a page instead of a file');
      }

      const vec = await res.body();
      if (vec.byteLength < 200) throw new Error('file too small — probably an error response');
      const ext = extFromDisposition(res, FORMAT);

      // Preview image (best effort — a missing thumbnail isn't a failure).
      let img = null, imgExt = 'png';
      try {
        const pRes = await ctx.request.get(`${BASE}/members/templates/showImage/${row.pvo_id}/preview`, { timeout: 60000 });
        const pct = (pRes.headers()['content-type'] || '').toLowerCase();
        if (pRes.ok() && !pct.includes('html')) {
          img = await pRes.body();
          imgExt = pct.includes('jpeg') || pct.includes('jpg') ? 'jpg' : 'png';
        }
      } catch { /* no preview */ }

      const slug = slugify(`${meta.make}-${meta.model}-${meta.year}-${base}`);
      const dir = `${sanitize(meta.make)}/${sanitize(meta.model)}/${meta.year || 'unknown'}`;

      const originalPath = `originals/${dir}/${slug}.${ext}`;
      await r2Put(originalPath, vec, contentTypeFor(ext));

      let imagePath = null;
      if (img) {
        imagePath = `previews/${dir}/${slug}.${imgExt}`;
        await r2Put(imagePath, img, imgExt === 'jpg' ? 'image/jpeg' : 'image/png');
      }

      const { data: tpl, error: insErr } = await supabase.from('vehicle_templates').insert({
        name: base,
        make: meta.make,
        model: meta.model,
        year: meta.year || null,
        template_image_path: imagePath,
        original_file_path: originalPath,
        px_per_in: calibrate(vec, img),
        is_active: true,
      }).select('id').single();
      if (insErr) throw new Error(`vehicle_templates insert failed: ${insErr.message}`);

      await supabase.from('pvo_catalog').update({
        status: 'downloaded',
        vehicle_template_id: tpl.id,
        file_format: ext,
        priority_rank: rank,
        error: null,
        downloaded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('pvo_id', row.pvo_id);

      downloaded++;
      names.push(base);
      log(`${tag}${downloaded}/${budget}  ${base}`);
    } catch (err) {
      if (err.message === 'SESSION_EXPIRED') {
        log('PVO session expired. Run: node scripts/pvo-sync.mjs --login');
        return { downloaded, failed, capHit, sessionExpired: true, names, failures };
      }
      failed++;
      failures.push({ name: base, error: err.message.slice(0, 200) });
      await supabase.from('pvo_catalog').update({
        status: 'failed',
        error: err.message.slice(0, 500),
        attempts: (row.attempts || 0) + 1,
        priority_rank: rank,
        updated_at: new Date().toISOString(),
      }).eq('pvo_id', row.pvo_id);
      log(`FAILED  ${base}: ${err.message}`);
    }

    await sleep(800);
  }

  return { downloaded, failed, capHit, pending: ranked.length - downloaded, names, failures };
}

async function lastRunState() {
  if (!supabase) return {};
  const { data } = await supabase.from('sync_state')
    .select('last_result').eq('sync_type', 'pvo_templates').maybeSingle();
  return data?.last_result || {};
}

async function recordRun(result) {
  if (!supabase) return;
  // names/failures go in the email, not the heartbeat row.
  const { names, failures, ...summary } = result;
  await supabase.from('sync_state').upsert({
    sync_type: 'pvo_templates',
    last_synced_at: new Date().toISOString(),
    last_result: summary,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'sync_type' });
}

async function catalogCounts() {
  const [done, left] = await Promise.all([
    supabase.from('pvo_catalog').select('pvo_id', { count: 'exact', head: true }).eq('status', 'downloaded'),
    supabase.from('pvo_catalog').select('pvo_id', { count: 'exact', head: true })
      .in('status', ['pending', 'failed']).lt('attempts', 3),
  ]);
  return { have: done.count || 0, left: left.count || 0 };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// One email a day, whatever happened — a quiet inbox should never be the
// only sign that the job stopped.
async function sendSummary({ subject, lines, names = [], failures = [] }) {
  if (DRY_RUN) return;
  if (!RESEND_API_KEY || !SUMMARY_TO.length) {
    log('No RESEND_API_KEY / PVO_SUMMARY_EMAIL — skipping the summary email.');
    return;
  }
  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;color:#111">',
    ...lines.map((l) => `<p style="margin:0 0 10px">${esc(l)}</p>`),
    names.length ? `<p style="margin:16px 0 6px"><b>Downloaded</b></p><ul style="margin:0;padding-left:20px">${names.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '',
    failures.length ? `<p style="margin:16px 0 6px"><b>Failed</b> (retried on later runs, up to 3 tries)</p><ul style="margin:0;padding-left:20px">${failures.map((f) => `<li>${esc(f.name)}: ${esc(f.error)}</li>`).join('')}</ul>` : '',
    '<p style="margin:20px 0 0;color:#666;font-size:12px">Sent by the daily PVO template sync (GitHub Actions → pvo-sync).</p>',
    '</div>',
  ].join('');
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${FROM_NAME} <${FROM_EMAIL}>`, to: SUMMARY_TO, subject, html }),
    });
    if (!res.ok) log(`Summary email failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    else log('Summary email sent.');
  } catch (err) {
    log(`Summary email failed: ${err.message}`);
  }
}

const SIGN_IN_HELP = 'Check the PVO_EMAIL and PVO_PASSWORD secrets in GitHub (Settings → Secrets and variables → Actions), then use "Run workflow" on the pvo-sync action to try again.';

// ── Main ──
async function main() {
  if (LOGIN_MODE) return doLogin();

  const ctx = await openBrowser({ headed: HEADFUL });
  const page = ctx.pages()[0] || await ctx.newPage();

  try {
    if (!(await isLoggedIn(ctx)) && !(await autoLogin(ctx, page))) {
      log(PVO_EMAIL
        ? 'Could not sign into PVO.'
        : 'Not signed into PVO. Set PVO_EMAIL / PVO_PASSWORD, or run: node scripts/pvo-sync.mjs --login');
      await recordRun({ downloaded: 0, failed: 0, message: 'not signed in' });
      await sendSummary({
        subject: 'PVO templates: sign-in failed, nothing downloaded',
        lines: ['The daily sync could not sign into Pro Vehicle Outlines, so no templates were downloaded today.', SIGN_IN_HELP],
      });
      process.exitCode = 2;
      return;
    }

    const prev = await lastRunState();
    const { count } = await supabase.from('pvo_catalog').select('pvo_id', { count: 'exact', head: true });
    const indexAge = prev.indexed_at ? Date.now() - Date.parse(prev.indexed_at) : Infinity;
    const freshIndex = RESCAN || !count || indexAge > RESCAN_EVERY_DAYS * 86400 * 1000;
    let indexedAt = prev.indexed_at || null;
    let indexedCount = null;
    if (freshIndex) {
      indexedCount = await indexCatalog(ctx, page);
      indexedAt = new Date().toISOString();
    }
    if (freshIndex || SEED_EXISTING) await seedExisting();

    const result = await runBatch(ctx);
    await recordRun({ ...result, indexed_at: indexedAt });
    await saveSession(ctx);

    const { have, left } = await catalogCounts();
    const lines = [];
    if (result.sessionExpired) {
      lines.push(`The PVO session ran out partway through: ${result.downloaded} downloaded before it stopped.`, SIGN_IN_HELP);
    } else if (result.skipped) {
      lines.push(`Nothing downloaded: ${LIMIT} were already taken in the last ${BUDGET_WINDOW_HOURS} hours.`);
    } else if (result.capHit) {
      lines.push(`PVO said the daily limit was reached after ${result.downloaded} downloads. The rest continue tomorrow.`);
    } else {
      lines.push(`${result.downloaded} template${result.downloaded === 1 ? '' : 's'} downloaded into FleetSuite${result.failed ? `, ${result.failed} failed` : ''}.`);
    }
    lines.push(`${have.toLocaleString()} downloaded so far, ${left.toLocaleString()} still to go.`);
    if (indexedCount != null) lines.push(`Catalog re-indexed this run: ${indexedCount.toLocaleString()} templates on PVO.`);
    const calibrated = computeCalibration ? 'New templates are calibrated for the wrap estimator automatically.' : 'Calibration was unavailable this run; use the admin backfill to calibrate the new templates.';
    if (result.downloaded) lines.push(calibrated);

    await sendSummary({
      subject: result.sessionExpired
        ? `PVO templates: sign-in lapsed after ${result.downloaded}`
        : `PVO templates: ${result.downloaded} downloaded, ${left.toLocaleString()} to go`,
      lines, names: result.names, failures: result.failures,
    });

    if (result.sessionExpired) process.exitCode = 2;
    if (result.capHit) {
      log(`PVO daily limit reached — ${result.downloaded} downloaded. Continues tomorrow.`);
    } else {
      log(`Done: ${result.downloaded} downloaded, ${result.failed} failed, ${left} still pending.`);
    }
  } finally {
    await ctx.close();
  }
}

main().catch(async (err) => {
  console.error('pvo-sync failed:', err);
  await recordRun({ downloaded: 0, failed: 0, message: err.message }).catch(() => {});
  await sendSummary({
    subject: 'PVO templates: the sync crashed',
    lines: [`The daily sync stopped with an error: ${err.message}`, 'The GitHub Actions log for the pvo-sync run has the details.'],
  });
  process.exit(1);
});
