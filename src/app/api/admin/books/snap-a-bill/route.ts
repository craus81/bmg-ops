import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { z } from '@/lib/validate';
import { ensureR2Cors, r2Get, r2GetBytes, r2Head, r2PresignPut, r2Upload } from '@/lib/r2';
import { readRecordFileBody, ROUTE_UPLOAD_MAX_BYTES } from '@/lib/record-file-route';
import { createVendorBill, findVendorBill, findVendors, transactionUrl } from '@/lib/netsuite';
import { madeOrFound, makeBillOnce, STALE_CLAIM_MS } from '@/lib/bill-once';
import { saveOwnBill } from '@/lib/books/own-bills';
import { logAudit } from '@/lib/audit';
import { BILL_FILE_TYPES, BILL_LINES_MAX, isoDay, readBill, type BillFileType } from '@/lib/books/bill-reader';
import {
  accountLabel, billToMarkSent, formFromRead, formOfRow, matchFor, matchVendor, plainSendError, readAccounts, readCompanies,
  readHistory, readNearby, readTerms, readVendor, readVendors, rowOfForm, searchVendors, sendUnfinished, settleForm,
  SNAP_STORAGE_PREFIX, SNAPPED_BILL_COLUMNS, snapToday, storedReadFrom, storedReadOf, viewSnapForm,
  type AskedNetsuite, type SnapAccount, type SnapCompany, type SnapFacts, type SnapForm, type SnappedBillRow,
  type StoredRead,
} from '@/lib/books/snap-a-bill';

export const dynamic = 'force-dynamic';
// Reading a bill is one call to Claude, which can take most of a minute on a long PDF.
export const maxDuration = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The pictures are stored as <uuid>.<ext> (migration 436's check on file_path). */
const PATH_RE = /^[0-9a-f-]{36}\.(jpg|png|webp|pdf)$/;
const EXT: Record<BillFileType, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
/** Claude reads a picture up to 5MB, and a PDF this big still fits its 32MB request once it's base64. */
const maxBytes = (type: BillFileType) => (type === 'application/pdf' ? 20 : 5) * 1024 * 1024;
const MEMO = 'FleetSuite Snap a bill';
const NOT_A_BILL = "This doesn't look like a vendor's bill. Fill it in by hand if it is one, or throw it away.";

/** NetSuite's page for each kind of document the notes link to. */
const PAGES: Record<string, Parameters<typeof transactionUrl>[0]> = { VendBill: 'vendbill', Check: 'check', CardChrg: 'cardchrg' };
const link = (type: string, netsuiteId: string) => {
  const page = PAGES[type];
  if (!page) return null;
  try {
    return transactionUrl(page, netsuiteId);
  } catch {
    // Without NetSuite's account in the environment there's no address to give.
    return null;
  }
};

const why = (e: unknown) => String((e as Error)?.message || e).slice(0, 300);
const refuse = (error: string, status = 400) => NextResponse.json({ error }, { status });
const gone = () => refuse("That bill isn't in Snap a bill.", 404);

// ── What the page sends ────────────────────────────────────────────────────

const CENTS_MAX = 100_000_000_000;
const day = z.string().refine((v) => isoDay(v) !== null, 'not a calendar day');
const netsuiteId = z.string().regex(/^\d{1,20}$/);
const cents = z.number().int().min(-CENTS_MAX).max(CENTS_MAX);
const FormSchema = z.object({
  company: z.string().min(1).max(12),
  vendorId: netsuiteId.nullable(),
  vendorName: z.string().max(200).nullable(),
  billNumber: z.string().max(200).nullable(),
  billDate: day.nullable(),
  dueDate: day.nullable(),
  duePicked: z.boolean(),
  totalCents: cents.nullable(),
  locationId: netsuiteId.nullable(),
  lines: z.array(z.object({
    description: z.string().max(300),
    cents: cents.nullable(),
    accountId: netsuiteId.nullable(),
    picked: z.boolean(),
  })).max(BILL_LINES_MAX),
});

const formFrom = (v: unknown): SnapForm | null => {
  const parsed = FormSchema.safeParse(v);
  return parsed.success ? parsed.data : null;
};

type UploadMeta = { type: BillFileType; size: number; name: string | null };

/** The file an upload says it is, or why FleetSuite won't take it. */
function uploadOf(body: Record<string, unknown>): UploadMeta | { error: string } {
  const type = String(body.contentType || '').toLowerCase();
  if (!(BILL_FILE_TYPES as readonly string[]).includes(type)) return { error: 'Take a picture of the bill, or pick its PDF (or a JPEG, PNG or WebP picture).' };
  const size = Number(body.size) || 0;
  if (size <= 0) return { error: 'That file is empty.' };
  const max = maxBytes(type as BillFileType);
  if (size > max) {
    const kind = type === 'application/pdf' ? 'a PDF' : 'a picture';
    return { error: `That file is ${(size / 1024 / 1024).toFixed(1)}MB: FleetSuite reads ${kind} up to ${max / 1024 / 1024}MB.` };
  }
  const name = String(body.fileName || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200);
  return { type: type as BillFileType, size, name: name || null };
}

// ── Reading ────────────────────────────────────────────────────────────────

async function readRow(service: SupabaseClient, id: string): Promise<SnappedBillRow | null> {
  const { data, error } = await service.from('gl_snapped_bills').select(SNAPPED_BILL_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new Error(`couldn't read the snapped bill (${error.message})`);
  return (data as SnappedBillRow | null) ?? null;
}

/** True while a Send to NetSuite holds the bill (src/lib/bill-once.ts). */
const held = (row: SnappedBillRow, now = Date.now()) => !!row.bill_claimed_at && now - Date.parse(row.bill_claimed_at) < STALE_CLAIM_MS;
/** The filter a change to a draft takes: no Send holds it, unless the one that did died (src/lib/bill-once.ts). */
const unheld = () => `bill_claimed_at.is.null,bill_claimed_at.lt.${new Date(Date.now() - STALE_CLAIM_MS).toISOString()}`;
/** A read that took long enough for the bill to be saved or sent meanwhile isn't used. */
const changedWhileRead = () => refuse('This bill was saved or sent while FleetSuite read it, so the read wasn\'t used. Refresh to see where it is.', 409);

/** Why a bill can't be changed now, or null when it can. */
function lockedWhy(row: SnappedBillRow): string | null {
  if (row.status === 'sent') return 'This bill is already in NetSuite.';
  if (row.status === 'thrown_away') return 'This bill was thrown away.';
  if (held(row)) return 'This bill is being sent to NetSuite. Wait a moment and refresh.';
  return null;
}

/** What NetSuite says when asked for a bill from the vendor with this number. */
async function askNetsuite(vendorId: string | null, number: string | null): Promise<AskedNetsuite> {
  if (!vendorId || !number) return null;
  try {
    const found = await findVendorBill(vendorId, number);
    return { found: found ? { netsuiteId: found.billId, number: found.billNumber || null, date: null, cents: null } : null };
  } catch (e) {
    return { error: why(e).replace(/[.\s]+$/, '') };
  }
}

/** Everything the view of a form is worked out from (src/lib/books/snap-a-bill.ts). */
async function gather(
  service: SupabaseClient, form: SnapForm, stored: StoredRead | null, companies: SnapCompany[], accounts: Map<string, SnapAccount>,
): Promise<SnapFacts> {
  const number = form.billNumber?.trim() || null;
  const [vendor, history, nearby, asked] = await Promise.all([
    form.vendorId ? readVendor(service, form.vendorId) : Promise.resolve(null),
    readHistory(service, form.vendorId, number),
    readNearby(service, form.billDate),
    askNetsuite(form.vendorId, number),
  ]);
  return {
    companies,
    accounts,
    vendor,
    match: matchFor(form.vendorId, vendor, stored),
    terms: await readTerms(service, vendor?.termsId ?? null),
    history,
    asked,
    nearby,
    read: stored?.read ?? null,
    defaultLocationId: process.env.NETSUITE_DEFAULT_LOCATION_ID || null,
    link,
    today: snapToday(),
  };
}

/** The companies and accounts the page picks from. */
const setupOf = (companies: SnapCompany[], accounts: Map<string, SnapAccount>) => ({
  companies: companies.map((c) => ({ code: c.code, name: c.name, linked: !!c.subsidiaryId, locations: c.locations })),
  accounts: [...accounts.values()]
    .filter((a) => a.companies.length)
    .sort((a, b) => (a.number ?? '').localeCompare(b.number ?? '', 'en', { numeric: true }) || a.name.localeCompare(b.name))
    .map((a) => ({ id: a.id, label: accountLabel(a), companies: a.companies })),
});

async function namesOf(service: SupabaseClient, ids: Array<string | null>): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((id): id is string => !!id))];
  if (!want.length) return new Map();
  const { data, error } = await service.from('profiles').select('id, full_name').in('id', want);
  if (error) throw new Error(`couldn't read who did it (${error.message})`);
  return new Map((data ?? []).map((p: { id: string; full_name: string | null }) => [p.id, p.full_name ?? 'a super admin']));
}

/** One snapped bill as the page shows it: the form, what's still to check, and its picture. */
async function oneBill(service: SupabaseClient, row: SnappedBillRow, given?: SnapForm) {
  const companies = await readCompanies(service);
  const accounts = await readAccounts(service, companies);
  const stored = storedReadFrom(row.read_result);
  let form = given ?? formOfRow(row, companies);
  let view = null;
  if (row.status === 'draft') {
    const facts = await gather(service, form, stored, companies, accounts);
    form = settleForm(form, facts);
    view = viewSnapForm(form, facts);
  }
  const names = await namesOf(service, [row.made_by, row.sent_by, row.thrown_away_by]);
  return {
    bill: {
      id: row.id,
      status: row.status,
      form,
      read: stored?.read ?? null,
      fileType: row.file_type,
      fileName: row.file_name,
      readAt: row.read_at,
      readError: row.read_error,
      sendError: row.send_error,
      sendUnfinished: sendUnfinished(row),
      netsuiteId: row.netsuite_id,
      netsuiteNumber: row.netsuite_number,
      netsuiteUrl: row.netsuite_id ? link('VendBill', row.netsuite_id) : null,
      sentAt: row.sent_at,
      sentBy: row.sent_by ? names.get(row.sent_by) ?? null : null,
      thrownAwayAt: row.thrown_away_at,
      thrownAwayBy: row.thrown_away_by ? names.get(row.thrown_away_by) ?? null : null,
      madeAt: row.made_at,
      madeBy: row.made_by ? names.get(row.made_by) ?? null : null,
    },
    view,
    setup: setupOf(companies, accounts),
  };
}

/**
 * GET /api/admin/books/snap-a-bill — the snapped bills saved for later,
 * newest first, for Books → Snap a bill (migration 436,
 * src/lib/books/snap-a-bill.ts).
 *   ?id=…      one snapped bill: its form with FleetSuite's suggestions, what's
 *              still to check before Send to NetSuite (NetSuite is asked whether
 *              it already has the bill), and the companies and accounts to pick
 *              from;
 *   ?file=…    the snapped bill's picture or PDF itself (deepLinks.booksSnapBillFile),
 *              never cached: the books-bills prefix is denied on /api/storage;
 *   ?vendors=… up to twelve NetSuite vendors with the words typed in their name,
 *              from the copy of NetSuite's vendor list, else from NetSuite.
 *
 * POST — the upload (presign, upload, record: src/lib/record-file-upload.ts),
 * then { action: 'read', id } FleetSuite reads the bill and fills in the form;
 * { action: 'check', id, form } what the page shows for the form as it is,
 * nothing saved; { action: 'save', id, form } Save for later;
 * { action: 'send', id, form } Send to NetSuite, once only (src/lib/bill-once.ts),
 * and Books keeps its own copy (src/lib/books/own-bills.ts);
 * { action: 'mark_sent', id, form } a bill whose Send didn't finish, which
 * NetSuite has, kept as sent with Books' own copy; { action: 'throw_away', id }.
 *
 * Super admin only: the books are being built hidden, for the owner, until
 * they're ready (docs/books.md).
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;
  const service = createServiceClient();
  const params = req.nextUrl.searchParams;

  try {
    const fileId = params.get('file');
    if (fileId !== null) {
      if (!UUID_RE.test(fileId)) return gone();
      const row = await readRow(service, fileId);
      if (!row) return gone();
      const got = await r2Get(SNAP_STORAGE_PREFIX, row.file_path);
      if (!got.success || !got.body) return refuse("The bill's picture isn't in storage.", 404);
      const type = (BILL_FILE_TYPES as readonly string[]).includes(row.file_type) ? row.file_type : 'application/octet-stream';
      const name = (row.file_name || `bill.${row.file_path.split('.').pop()}`).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      return new NextResponse(got.body as unknown as BodyInit, {
        headers: {
          'Content-Type': type,
          'Content-Disposition': `inline; filename="${name}"`,
          // A vendor's bill: never kept by a shared cache, nor on disk once the tab closes.
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          ...(got.contentLength ? { 'Content-Length': String(got.contentLength) } : {}),
        },
      });
    }

    const typed = params.get('vendors');
    if (typed !== null) {
      const copied = await searchVendors(service, typed);
      if (copied.length || typed.trim().length < 3) return NextResponse.json({ vendors: copied.map((v) => ({ id: v.id, name: v.name })) });
      // A vendor made in NetSuite since the copy last ran (every two hours) is asked of NetSuite itself.
      const live = await findVendors(typed.trim());
      return NextResponse.json({
        vendors: live.vendors.map((v) => ({ id: v.id, name: v.companyName || v.entityId })),
        ...(live.error ? { error: `NetSuite couldn't be searched: ${live.error}` } : {}),
      });
    }

    const id = params.get('id');
    if (id !== null) {
      if (!UUID_RE.test(id)) return gone();
      const row = await readRow(service, id);
      if (!row) return gone();
      return NextResponse.json(await oneBill(service, row));
    }

    const { data, error } = await service
      .from('gl_snapped_bills')
      .select('id, vendor_name, bill_number, bill_date, total, read_at, read_error, file_name, made_at, saved_at')
      .eq('status', 'draft')
      .order('saved_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(`couldn't read the bills saved for later (${error.message})`);
    return NextResponse.json({
      drafts: (data ?? []).map((d: Record<string, any>) => ({
        id: d.id,
        vendorName: d.vendor_name,
        billNumber: d.bill_number,
        billDate: d.bill_date,
        totalCents: d.total === null ? null : Math.round(Number(d.total) * 100),
        read: !!d.read_at && !d.read_error,
        fileName: d.file_name,
        savedAt: d.saved_at,
      })),
    });
  } catch (e) {
    return refuse(`FleetSuite ${why(e)}.`, 500);
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;
  const actorId = auth.user.id;

  const parsed = await readRecordFileBody(req);
  if (!parsed) return refuse("That request couldn't be read.");
  const body = (parsed.body && typeof parsed.body === 'object' ? parsed.body : {}) as Record<string, unknown>;
  const service = createServiceClient();
  const action = body.action;

  try {
    // ── The upload: presign → the browser's PUT to storage (or upload through here) → record.
    if (action === 'presign' || action === 'upload' || action === 'record') {
      const meta = uploadOf(body);
      if ('error' in meta) return refuse(meta.error);

      if (action === 'presign') {
        const path = `${randomUUID()}.${EXT[meta.type]}`;
        // The PUT that follows is a cross-origin browser request; heal the bucket's CORS rules first.
        await ensureR2Cors();
        const { url } = await r2PresignPut(SNAP_STORAGE_PREFIX, path, meta.type);
        return NextResponse.json({ success: true, uploadUrl: url, path });
      }

      if (action === 'upload') {
        const file = parsed.file;
        if (!file) return refuse('No file came with the upload.');
        if (file.size > ROUTE_UPLOAD_MAX_BYTES) return refuse('That file is too big to upload through FleetSuite.', 413);
        const path = `${randomUUID()}.${EXT[meta.type]}`;
        const up = await r2Upload(SNAP_STORAGE_PREFIX, path, Buffer.from(await file.arrayBuffer()), meta.type);
        if (!up.success) return refuse(`Storage didn't take the file (${up.error || 'no reason given'}).`, 502);
        return NextResponse.json({ success: true, path });
      }

      // record: only a path this route made, for the type it was made for.
      const path = String(body.path || '');
      if (!PATH_RE.test(path) || !path.endsWith(`.${EXT[meta.type]}`)) return refuse("That upload isn't one Snap a bill started.");
      if (!(await r2Head(SNAP_STORAGE_PREFIX, path))) return refuse("The file didn't reach storage. Try again.", 409);
      const { data: bmg, error: companyErr } = await service.from('gl_companies').select('id').eq('code', 'BMG').maybeSingle();
      if (companyErr || !bmg) return refuse("FleetSuite couldn't find the BMG company in the books.", 500);
      const { data, error } = await service
        .from('gl_snapped_bills')
        .insert({ company_id: bmg.id, file_path: path, file_type: meta.type, file_name: meta.name, made_by: actorId })
        .select('id')
        .single();
      if (error || !data) {
        if (error?.code === '23505') return refuse('That file is already in Snap a bill.', 409);
        return refuse(`FleetSuite couldn't save the bill (${error?.message || 'no row came back'}).`, 500);
      }
      return NextResponse.json({ success: true, file: { id: data.id } });
    }

    const id = typeof body.id === 'string' ? body.id : '';
    if (!UUID_RE.test(id)) return gone();
    const row = await readRow(service, id);
    if (!row) return gone();
    const now = new Date().toISOString();

    // ── Read it (again): Claude reads the picture, and FleetSuite fills in the form from it.
    if (action === 'read') {
      const locked = lockedWhy(row);
      if (locked) return refuse(locked, 409);
      const type = row.file_type as BillFileType;
      const apiKey = process.env.ANTHROPIC_API_KEY;
      const got = await r2GetBytes(SNAP_STORAGE_PREFIX, row.file_path, maxBytes(type));
      const result = !got
        ? { error: "FleetSuite couldn't open the file from storage." }
        : apiKey ? await readBill(got.bytes, type, apiKey) : { error: "The reader isn't set up: ANTHROPIC_API_KEY is missing." };
      if ('error' in result) {
        const { data: kept, error } = await service
          .from('gl_snapped_bills')
          .update({ read_at: now, read_error: result.error })
          .eq('id', id)
          .eq('status', 'draft')
          .eq('saved_at', row.saved_at)
          .or(unheld())
          .select('id');
        if (error) throw new Error(`couldn't save the read (${error.message})`);
        if (!kept?.length) return changedWhileRead();
        const fresh = await readRow(service, id);
        return NextResponse.json(await oneBill(service, fresh ?? row));
      }

      const { read } = result;
      const companies = await readCompanies(service);
      const [accounts, vendors] = await Promise.all([readAccounts(service, companies), readVendors(service)]);
      const match = matchVendor(read.vendorName, vendors);
      const [terms, history] = await Promise.all([
        readTerms(service, match.vendor?.termsId ?? null),
        readHistory(service, match.vendor?.id ?? null, read.billNumber),
      ]);
      const form = formFromRead(read, {
        companies, accounts, vendor: match.vendor, terms, history, read,
        defaultLocationId: process.env.NETSUITE_DEFAULT_LOCATION_ID || null, today: snapToday(),
      });
      const company = companies.find((c) => c.code === form.company) ?? companies.find((c) => c.code === 'BMG');
      if (!company) throw new Error("couldn't find the BMG company in the books");
      // Only onto the form as it was when the read began: one saved or sent since is left as it is.
      const { data: kept, error } = await service
        .from('gl_snapped_bills')
        .update({
          read_result: storedReadOf(read, match), read_at: now, read_error: read.isBill ? null : NOT_A_BILL,
          ...rowOfForm(form, company.id), saved_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('status', 'draft')
        .eq('saved_at', row.saved_at)
        .or(unheld())
        .select('id');
      if (error) throw new Error(`couldn't save the read (${error.message})`);
      if (!kept?.length) return changedWhileRead();
      const fresh = await readRow(service, id);
      return NextResponse.json(await oneBill(service, fresh ?? row));
    }

    // ── Throw it away: kept, with its picture, marked thrown away.
    if (action === 'throw_away') {
      const { data, error } = await service
        .from('gl_snapped_bills')
        .update({ status: 'thrown_away', thrown_away_at: now, thrown_away_by: actorId })
        .eq('id', id)
        .eq('status', 'draft')
        .or(unheld())
        .select('id');
      if (error) throw new Error(`couldn't throw it away (${error.message})`);
      if (!data?.length) return refuse(lockedWhy(row) ?? 'This bill changed. Refresh to see where it is.', 409);
      await logAudit(service, { actorId, table: 'gl_snapped_bills', recordId: id, action: 'throw_away', detail: { vendor: row.vendor_name, bill_number: row.bill_number } });
      return NextResponse.json({ thrownAway: true });
    }

    const sentLines = (body.form as { lines?: unknown } | null | undefined)?.lines;
    if (Array.isArray(sentLines) && sentLines.length > BILL_LINES_MAX) return refuse(`Snap a bill takes up to ${BILL_LINES_MAX} lines: put some together.`);
    const form = formFrom(body.form);
    if (!form) return refuse("The form couldn't be read. Refresh the page and try again.");
    const companies = await readCompanies(service);
    const company = companies.find((c) => c.code === form.company);
    if (!company) return refuse(`FleetSuite doesn't know the company ${form.company}.`);

    // ── What the page shows for the form as it is now. Nothing is saved.
    if (action === 'check') {
      if (row.status !== 'draft') return refuse(lockedWhy(row) ?? 'This bill changed. Refresh.', 409);
      const accounts = await readAccounts(service, companies);
      const facts = await gather(service, form, storedReadFrom(row.read_result), companies, accounts);
      const settled = settleForm(form, facts);
      return NextResponse.json({ form: settled, view: viewSnapForm(settled, facts) });
    }

    const locked = lockedWhy(row);
    if (locked) return refuse(locked, 409);
    // What's on the page is kept first, Save for later or Send, so a refusal loses nothing; never over a Send in flight.
    const { data: kept, error: saveErr } = await service
      .from('gl_snapped_bills')
      .update({ ...rowOfForm(form, company.id), saved_at: now })
      .eq('id', id)
      .eq('status', 'draft')
      .or(unheld())
      .select('id');
    if (saveErr) throw new Error(`couldn't save the bill (${saveErr.message})`);
    if (!kept?.length) {
      const fresh = await readRow(service, id);
      return refuse((fresh && lockedWhy(fresh)) ?? 'This bill changed. Refresh to see where it is.', 409);
    }

    if (action === 'save') return NextResponse.json({ saved: true });

    if (action !== 'send' && action !== 'mark_sent') return refuse('Read it, check it, save it, send it, or throw it away.');

    // ── Send to NetSuite: only what the page showed, checked again here, NetSuite asked again.
    const accounts = await readAccounts(service, companies);
    const facts = await gather(service, form, storedReadFrom(row.read_result), companies, accounts);
    const view = viewSnapForm(form, facts);
    // ── Mark it sent: NetSuite has the bill from a Send here that didn't finish (the connection dropped after
    // NetSuite kept it, or the bill couldn't be marked sent), so it's kept as sent, with Books' own copy, not sent again.
    const marking = action === 'mark_sent';
    const marked = marking ? billToMarkSent(sendUnfinished(row), view, facts.asked, form.billNumber?.trim() ?? '') : null;
    if (marked && 'error' in marked) return NextResponse.json({ error: marked.error, view }, { status: 409 });
    if (!marking && !view.canSend) {
      return NextResponse.json({ error: view.stop?.text ?? view.problems[0] ?? 'Check the bill before sending.', view }, { status: 409 });
    }
    const vendorId = form.vendorId!;
    const referenceNo = form.billNumber!.trim();
    const vendorName = facts.vendor?.name ?? form.vendorName?.trim() ?? `NetSuite vendor ${vendorId}`;
    const lines = form.lines.map((l) => ({ accountId: l.accountId!, amount: l.cents! / 100, ...(l.description.trim() ? { memo: l.description.trim() } : {}) }));
    let made: { billId: string; billNumber: string; claimedAt: string | null };
    if (marked) {
      made = { billId: marked.bill.netsuiteId, billNumber: marked.bill.number ?? '', claimedAt: null };
    } else {
      const bill = await makeBillOnce(service, 'gl_snapped_bills', id, {
        vendorId,
        vendorName,
        referenceNo,
        create: () => madeOrFound(() => createVendorBill({
          vendorId,
          referenceNo,
          subsidiaryId: company.subsidiaryId!,
          ...(form.locationId ? { locationId: form.locationId } : {}),
          tranDate: form.billDate!,
          ...(form.dueDate ? { dueDate: form.dueDate } : {}),
          memo: MEMO,
          lines,
        }), () => findVendorBill(vendorId, referenceNo)),
      });
      if (!bill.ok) {
        const error = plainSendError(bill.error);
        await service.from('gl_snapped_bills').update({ send_error: error }).eq('id', id).eq('status', 'draft');
        return refuse(error, bill.status);
      }
      made = bill;
    }
    const number = made.billNumber || referenceNo;
    // The claim stays held when the bill can't be marked sent, so nobody sends it again while it reads as a draft.
    if (!/^\d+$/.test(made.billId)) {
      return refuse(`NetSuite made bill ${number} but didn't say which one it is, so FleetSuite couldn't mark it sent. Don't send it again: find bill ${number} in NetSuite.`, 502);
    }
    // The row keeps the form that went to NetSuite, whatever another tab saved meanwhile.
    const stamp = service
      .from('gl_snapped_bills')
      .update({
        ...rowOfForm(form, company.id),
        status: 'sent', netsuite_id: made.billId, netsuite_number: made.billNumber || null, sent_at: now, sent_by: actorId, send_error: null,
        ...(made.claimedAt || marking ? { bill_claimed_at: null } : {}),
      })
      .eq('id', id);
    // Marking it sent holds no claim of its own: it only goes onto a draft no Send holds.
    const { data: stamped, error: stampErr } = await (marking ? stamp.eq('status', 'draft').or(unheld()) : stamp).select('id');
    if (stampErr) {
      return refuse(`Bill ${number} is in NetSuite, but FleetSuite couldn't mark it sent (${stampErr.message}). Don't send it again.`, 500);
    }
    if (!stamped?.length) return refuse('This bill changed. Refresh to see where it is.', 409);
    // Books keeps its own copy of what was sent; it never stops the bill.
    await saveOwnBill(service, {
      netsuiteId: made.billId, netsuiteNumber: made.billNumber, madeFrom: 'snapped', madeFromId: id, madeBy: actorId,
      vendorId, vendorName, referenceNo, subsidiaryId: company.subsidiaryId, locationId: form.locationId,
      expenses: lines, billDate: form.billDate, invoiceTotal: form.totalCents! / 100,
    });
    await logAudit(service, {
      actorId, table: 'gl_snapped_bills', recordId: id, action: marking ? 'mark_sent' : 'send',
      detail: { vendor: vendorName, amount: form.totalCents! / 100, company: company.code, netsuite_bill_id: made.billId, bill_number: number },
    });
    const fresh = await readRow(service, id);
    return NextResponse.json(await oneBill(service, fresh ?? row));
  } catch (e) {
    return refuse(`FleetSuite ${why(e)}.`, 500);
  }
}
