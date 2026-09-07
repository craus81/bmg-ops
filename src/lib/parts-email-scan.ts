import type { SupabaseClient } from '@supabase/supabase-js';
import { dwdConfigured, getDelegatedGmail, getMessagePlainText, getHeader } from '@/lib/google-dwd';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import { callAnthropicWithRetry } from '@/lib/anthropic';
import { getPdfAttachments } from '@/lib/google';
import { r2Upload } from '@/lib/r2';
import { fetchAllRows } from '@/lib/fetch-all';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { isOpenPoStatus } from '@/lib/vendor-po-sync';

/**
 * Parts-ETA email scan: read watched BMG mailboxes (domain-wide delegation,
 * read-only) for vendor order confirmations and ship notices, AI-extract the
 * PO number + ship/ETA dates + tracking, and apply them to the synced
 * NetSuite vendor POs — propagating parts_eta to any upfit project that
 * references the PO. Anything parts-related that can't be matched lands in
 * the review queue (/admin/parts-mail) instead of being guessed at.
 */

// Subject-level prefilter — the AI classifier makes the real call, this just
// keeps the candidate pool (and token spend) small.
const SEARCH_QUERY =
  'newer_than:7d (subject:"order confirmation" OR subject:"order acknowledgement" OR subject:"order acknowledgment" OR subject:"shipping confirmation" OR subject:"shipment" OR subject:"shipped" OR subject:"tracking" OR subject:"ship notice" OR subject:"backorder" OR subject:"back order" OR subject:"eta" OR subject:"invoice")';

const MAX_ATTACHMENTS_PER_EMAIL = 3;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const MAX_MESSAGES_PER_MAILBOX = 25;
const MAX_AI_CALLS_PER_RUN = 20;
const BODY_CHAR_LIMIT = 6000;

const digitsOnly = (s: string | null | undefined) => String(s || '').replace(/\D/g, '');
/** Case-fold and strip everything but letters/digits so "PO-376" ≡ "po376". */
const alnumOnly = (s: string | null | undefined) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const PO_SELECT = 'id, tranid, vendor_name, eta_date, tracking_number';
export type MatchedPo = { id: string; tranid: string | null; vendor_name: string | null; eta_date: string | null; tracking_number: string | null };

export interface PartsEmailScanResult {
  skipped?: string;
  mailboxes: number;
  candidates: number;
  processed: number;
  applied: number;
  review: number;
  errors: number;
  /** Outcome of the sync_state heartbeat write — not persisted, only reported. */
  syncStateWrite?: HeartbeatResult;
}

interface ExtractedEmail {
  vendor_name: string | null;
  po_number: string | null;
  ship_date: string | null;
  eta_date: string | null;
  tracking_number: string | null;
  carrier: string | null;
  is_invoice?: boolean;
  invoice_number?: string | null;
  invoice_date?: string | null;
  invoice_total?: number | null;
}

/**
 * Find a synced vendor PO by its NetSuite PO number. Exact tranid first, then
 * a digit-string match so "PO376" ↔ "376" ↔ "PO-376" all resolve.
 *
 * The digit match runs over the FULL PO history (paginated past PostgREST's
 * 1000-row cap) — the old `.limit(500)` silently hid any PO outside the 500
 * most-recent, so linking to an older PO always failed with "no match".
 */
export async function findPoByNumber(service: SupabaseClient, poNumber: string): Promise<MatchedPo | null> {
  const target = poNumber.trim();
  if (!target) return null;

  // 1. Exact tranid (case-insensitive), no wildcards.
  const { data: exact } = await service
    .from('netsuite_vendor_pos')
    .select(PO_SELECT)
    .ilike('tranid', target)
    .limit(1)
    .maybeSingle();
  if (exact) return exact as MatchedPo;

  const digits = digitsOnly(target);
  if (digits) {
    // 2. Narrow to tranids containing those digits (a specific number is a
    //    tiny result set), then require exact digit-string equality so "376"
    //    never matches "1376". Paginated so no PO age is out of reach.
    const { data: byDigits } = await fetchAllRows<MatchedPo>((from, to) =>
      service
        .from('netsuite_vendor_pos')
        .select(PO_SELECT)
        .ilike('tranid', `%${digits}%`)
        .order('id')
        .range(from, to),
    );
    return byDigits.find(p => digitsOnly(p.tranid) === digits) || null;
  }

  // 3. Alpha-only reference (no digits at all): normalized full compare.
  const targetAlnum = alnumOnly(target);
  if (!targetAlnum) return null;
  const { data: all } = await fetchAllRows<MatchedPo>((from, to) =>
    service.from('netsuite_vendor_pos').select(PO_SELECT).order('id').range(from, to),
  );
  return all.find(p => alnumOnly(p.tranid) === targetAlnum) || null;
}

/**
 * Write an email's extracted data onto a vendor PO and propagate the ETA to
 * upfit projects that reference the PO number. Returns 'applied' when
 * something was written, 'linked' when there was nothing new to write.
 *
 * R3-12: an ETA CHANGE also notifies the people waiting on it — the write
 * used to happen silently, so nobody learned the date moved until they
 * happened to open the project. `actorId` (the staff member on the manual
 * link path) is excluded from the fan-out.
 */
export async function applyEmailToPo(
  service: SupabaseClient,
  extracted: ExtractedEmail,
  po: MatchedPo,
  sourceLabel: string,
  actorId?: string | null,
): Promise<'applied' | 'linked'> {
  const eta = extracted.eta_date || extracted.ship_date || null;
  // Compared against the PO's stored ETA BEFORE this write — the change is
  // the signal; a re-send of the same date must not re-ping anyone.
  const etaChanged = !!eta && po.eta_date !== eta;
  const updates: Record<string, unknown> = {};
  if (eta) { updates.eta_date = eta; updates.eta_source = 'email'; }
  if (extracted.tracking_number) updates.tracking_number = extracted.tracking_number;
  if (extracted.carrier) updates.carrier = extracted.carrier;
  if (Object.keys(updates).length === 0) return 'linked';

  await service.from('netsuite_vendor_pos').update(updates).eq('id', po.id);

  // Upfit projects linked to this PO get the ETA (and a timeline note so
  // the change is attributable). Join-table links (migration 267) govern
  // when a project has any; the scalar first-PO match covers only projects
  // with NO join rows at all — post-backfill that means "nothing linked",
  // so a deliberate unlink stays unlinked. A project's parts_eta is the
  // MAX across its open linked POs (it waits for all its parts), which is
  // exactly today's date for the single-PO majority.
  const affectedProjects: {
    id: string; project_name: string | null;
    assigned_to: string | null; created_by: string | null;
  }[] = [];
  {
    const linkedIds = new Set<string>();
    const { data: joinRows } = await service
      .from('upfit_project_pos')
      .select('project_id')
      .eq('po_id', po.id);
    for (const j of joinRows || []) linkedIds.add(j.project_id as string);

    // Scalar fallback — same exact/digits match as always. Paginated: the
    // unpaginated read silently capped at PostgREST's 1000 rows, so
    // projects past it never got ETAs.
    const scalarIds = new Set<string>();
    if (po.tranid) {
      const { data: projects } = await fetchAllRows<any>((from, to) => service
        .from('upfit_projects')
        .select('id, netsuite_vendor_po_number')
        .not('netsuite_vendor_po_number', 'is', null)
        .order('id')
        .range(from, to));
      const poDigits = digitsOnly(po.tranid);
      for (const proj of projects || []) {
        const ref = String(proj.netsuite_vendor_po_number || '').trim();
        const matches = ref.toLowerCase() === po.tranid.toLowerCase() || (poDigits && digitsOnly(ref) === poDigits);
        if (matches && !linkedIds.has(proj.id)) scalarIds.add(proj.id);
      }
      // A scalar match on a project that HAS join rows (to other POs) is
      // stale wiring — the join table governs it, so drop the match.
      if (scalarIds.size > 0) {
        const { data: anyLinks } = await service
          .from('upfit_project_pos')
          .select('project_id')
          .in('project_id', [...scalarIds]);
        for (const l of anyLinks || []) scalarIds.delete(l.project_id as string);
      }
    }

    const candidateIds = [...linkedIds, ...scalarIds];
    if (eta && candidateIds.length > 0) {
      const [{ data: projRows }, { data: allLinks }] = await Promise.all([
        service.from('upfit_projects')
          .select('id, project_name, parts_eta, assigned_to, created_by')
          .in('id', candidateIds),
        service.from('upfit_project_pos')
          .select('project_id, po:netsuite_vendor_pos(id, eta_date, status)')
          .in('project_id', candidateIds),
      ]);
      // Other open POs' ETAs per project — this PO's FRESH date joins below.
      const otherEtas = new Map<string, string[]>();
      for (const l of (allLinks || []) as any[]) {
        if (!l.po || l.po.id === po.id) continue;
        if (!isOpenPoStatus(l.po.status) || !l.po.eta_date) continue;
        otherEtas.set(l.project_id, [...(otherEtas.get(l.project_id) || []), l.po.eta_date]);
      }
      for (const proj of projRows || []) {
        // ISO dates compare lexicographically, so string max is date max.
        const projectEta = [eta, ...(otherEtas.get(proj.id) || [])].reduce((a, b) => (a >= b ? a : b));
        const projChanged = proj.parts_eta !== projectEta;
        // A re-send of an already-reflected date writes and pings nothing.
        if (!etaChanged && !projChanged) continue;
        if (projChanged) {
          await service.from('upfit_projects').update({ parts_eta: projectEta }).eq('id', proj.id);
        }
        await service.from('upfit_project_notes').insert({
          project_id: proj.id,
          note_type: 'parts_order',
          content: etaChanged
            ? `Parts ETA: PO ${po.tranid || ''} now ${eta} from ${po.vendor_name || 'vendor'} email (${sourceLabel})${extracted.tracking_number ? ` — tracking ${extracted.tracking_number}` : ''}${projectEta !== eta ? `; project waits for ${projectEta} (latest open PO)` : ''}`.trim()
            : `Project parts ETA recomputed to ${projectEta} across open POs (${sourceLabel})`,
        });
        affectedProjects.push({
          id: proj.id, project_name: proj.project_name || null,
          assigned_to: proj.assigned_to || null, created_by: proj.created_by || null,
        });
      }
    }
  }

  if (etaChanged && eta) {
    try {
      await notifyEtaChange(service, po, eta, affectedProjects, actorId || null);
    } catch (err) {
      console.warn('PO ETA-change notification failed:', err);
    }
  }
  return 'applied';
}

/**
 * Fan out a PO's ETA change to the people waiting on it: each affected
 * project's assignee + creator (project link — projects reach here through
 * upfit_project_pos, so PO #2's people hear it too), plus the requesters
 * whose purchase requests were ordered on this PO (their own request link
 * when a project isn't in play). The "was" date is the PO's own prior
 * expectation (po.eta_date is read before the write), not the project's —
 * a project gated by a later PO never said this PO's old date.
 */
async function notifyEtaChange(
  service: SupabaseClient,
  po: MatchedPo,
  eta: string,
  affectedProjects: { id: string; project_name: string | null; assigned_to: string | null; created_by: string | null }[],
  actorId: string | null,
): Promise<void> {
  const { data: reqs } = await service
    .from('purchase_requests')
    .select('id, requested_by, source_project_id')
    .eq('ordered_po_id', po.id);
  const requests = reqs || [];
  const poLabel = po.tranid ? `PO ${po.tranid}` : 'a vendor PO';
  const vendor = po.vendor_name || 'The vendor';
  const notified = new Set<string>(actorId ? [actorId] : []);

  // Project-centric fan-out: one ping per affected project, linking to it.
  for (const proj of affectedProjects) {
    const ids = new Set<string>();
    if (proj.assigned_to) ids.add(proj.assigned_to);
    if (proj.created_by) ids.add(proj.created_by);
    for (const r of requests) {
      if (r.source_project_id === proj.id && r.requested_by) ids.add(r.requested_by);
    }
    for (const done of notified) ids.delete(done);
    if (ids.size === 0) continue;
    await notifyMany([...ids], {
      type: 'po_eta_changed',
      title: `📦 Parts ETA updated — ${poLabel}`,
      body: `${vendor} now expects ${eta}${po.eta_date ? ` (was ${po.eta_date})` : ''} — ${proj.project_name || 'upfit project'}.`.slice(0, 900),
      url: deepLinks.upfitProject(proj.id),
    });
    for (const id of ids) notified.add(id);
  }

  // Requesters not reached through a project (stock asks, or a project the
  // PO-number match missed): link each to their own request.
  const affectedIds = new Set(affectedProjects.map(p => p.id));
  const byRequester = new Map<string, string[]>();
  for (const r of requests) {
    if (!r.requested_by || notified.has(r.requested_by)) continue;
    if (r.source_project_id && affectedIds.has(r.source_project_id)) continue;
    byRequester.set(r.requested_by, [...(byRequester.get(r.requested_by) || []), r.id]);
  }
  for (const [uid, requestIds] of byRequester) {
    await notifyMany([uid], {
      type: 'po_eta_changed',
      title: `📦 Parts ETA updated — ${poLabel}`,
      body: `${vendor} now expects ${eta} for part${requestIds.length !== 1 ? 's' : ''} you requested.`.slice(0, 900),
      url: deepLinks.purchaseRequests(requestIds.length === 1 ? requestIds[0] : undefined),
    });
  }
}

async function classifyEmail(
  subject: string,
  from: string,
  body: string,
  knownPos: { tranid: string; vendor_name: string | null }[],
): Promise<({ is_parts_order_update: boolean; summary: string | null } & ExtractedEmail) | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const poContext = knownPos
    .slice(0, 150)
    .map(p => `${p.tranid}${p.vendor_name ? ` (${p.vendor_name})` : ''}`)
    .join(', ');

  const prompt = `You are reading an email from a company mailbox at BMG Fleet, a vehicle upfitting shop that buys parts from vendors (Ranger Design, Masterack, Legend Fleet, Meyer Distributing, Buyers Products, and others).

Decide whether this email is a PARTS ORDER UPDATE from a vendor — an order confirmation / acknowledgement, shipping confirmation, ship notice, tracking notification, backorder notice, ETA update, or an INVOICE for parts BMG ordered. Marketing emails, customer emails, internal mail, and invoices for services (not parts) are NOT parts order updates.

Recent BMG purchase order numbers for reference (match po_number to one of these when the email references it, keeping the exact format shown here): ${poContext || '(none synced yet)'}

FROM: ${from}
SUBJECT: ${subject}
BODY:
${body}

Reply with ONLY a JSON object, no other text:
{
  "is_parts_order_update": true/false,
  "vendor_name": "vendor company name or null",
  "po_number": "BMG's PO number referenced in the email, or null",
  "ship_date": "YYYY-MM-DD or null — the date the order shipped/ships",
  "eta_date": "YYYY-MM-DD or null — expected delivery/arrival date; if only a ship date and transit estimate are given, compute the arrival date; null if truly unknown",
  "tracking_number": "tracking number or null",
  "carrier": "carrier name (UPS, FedEx, freight line...) or null",
  "is_invoice": true/false — is this email delivering a vendor INVOICE (a bill BMG must pay)?,
  "invoice_number": "the vendor's invoice number, or null",
  "invoice_date": "YYYY-MM-DD or null",
  "invoice_total": invoice total as a plain number, or null,
  "summary": "one short sentence: what this email says (or why it's not a parts update)"
}`;

  const response = await callAnthropicWithRetry(
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    },
    apiKey,
  );
  if (!response.ok) throw new Error(`AI API error ${response.status}`);
  const result = await response.json();
  const text = result.content?.[0]?.text || '';
  const jsonMatch = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in AI response');
  const data = JSON.parse(jsonMatch[0]);
  const dateOk = (d: any) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
  return {
    is_parts_order_update: !!data.is_parts_order_update,
    vendor_name: data.vendor_name || null,
    po_number: data.po_number ? String(data.po_number) : null,
    ship_date: dateOk(data.ship_date),
    eta_date: dateOk(data.eta_date),
    tracking_number: data.tracking_number ? String(data.tracking_number) : null,
    carrier: data.carrier || null,
    is_invoice: !!data.is_invoice,
    invoice_number: data.invoice_number ? String(data.invoice_number) : null,
    invoice_date: dateOk(data.invoice_date),
    invoice_total: typeof data.invoice_total === 'number' ? data.invoice_total : null,
    summary: data.summary || null,
  };
}

/**
 * Pull an invoice email's PDF attachments into R2 and record them in
 * vendor_parts_invoices, ready for one-click bill creation. Best-effort —
 * a failed attachment never fails the email.
 */
async function captureInvoiceAttachments(
  service: SupabaseClient,
  gmail: ReturnType<typeof getDelegatedGmail>,
  message: any,
  emailRowId: string,
  mailbox: string,
  extracted: ExtractedEmail,
  matchedPoId: string | null,
): Promise<number> {
  const pdfs = getPdfAttachments(message).slice(0, MAX_ATTACHMENTS_PER_EMAIL);

  // The same vendor invoice routinely lands in several watched mailboxes (and
  // gets forwarded around the office), and each mailbox is scanned on its own
  // — so capture an invoice once, keyed on vendor + invoice number. Read the
  // array (not .maybeSingle) since pre-existing dupes would make it throw.
  if (extracted.invoice_number) {
    let dupeQuery = service
      .from('vendor_parts_invoices')
      .select('id')
      .eq('invoice_number', extracted.invoice_number)
      .neq('status', 'dismissed');
    if (extracted.vendor_name) dupeQuery = dupeQuery.eq('vendor_name', extracted.vendor_name);
    const { data: existing } = await dupeQuery.limit(1);
    if (existing && existing.length > 0) return 0;
  }

  let captured = 0;
  for (const pdf of pdfs) {
    try {
      if (pdf.size > MAX_ATTACHMENT_BYTES) continue;
      const att = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: message.id,
        id: pdf.attachmentId,
      });
      const b64 = (att.data.data || '').replace(/-/g, '+').replace(/_/g, '/');
      if (!b64) continue;
      const buffer = Buffer.from(b64, 'base64');
      const safeName = pdf.filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
      const path = `${emailRowId}/${safeName}`;
      const upload = await r2Upload('parts-invoices', path, buffer, 'application/pdf');
      if (!upload.success) continue;
      await service.from('vendor_parts_invoices').insert({
        email_id: emailRowId,
        mailbox,
        file_name: pdf.filename.slice(0, 200),
        storage_path: path,
        content_type: 'application/pdf',
        file_size: buffer.length,
        vendor_name: extracted.vendor_name,
        invoice_number: extracted.invoice_number || null,
        invoice_date: extracted.invoice_date || null,
        total: extracted.invoice_total ?? null,
        matched_po_id: matchedPoId,
      });
      captured++;
    } catch (e: any) {
      console.error(`[parts-email] attachment capture failed (${pdf.filename}):`, e?.message);
    }
  }
  return captured;
}

async function heartbeat(service: SupabaseClient, result: PartsEmailScanResult): Promise<HeartbeatResult> {
  const { syncStateWrite: _omit, ...payload } = result;
  return recordHeartbeat(service, 'parts_email_scan', payload);
}

export async function scanPartsEmails(service: SupabaseClient): Promise<PartsEmailScanResult> {
  const result: PartsEmailScanResult = { mailboxes: 0, candidates: 0, processed: 0, applied: 0, review: 0, errors: 0 };

  // Intentional skips still heartbeat — a disabled scan isn't a down scan.
  if (!dwdConfigured()) {
    const skipped = { ...result, skipped: 'GOOGLE_DWD_* env vars not set' };
    return { ...skipped, syncStateWrite: await heartbeat(service, skipped) };
  }

  const { data: settings } = await service
    .from('parts_email_settings')
    .select('enabled, mailboxes')
    .eq('id', 1)
    .maybeSingle();
  if (!settings?.enabled) {
    const skipped = { ...result, skipped: 'disabled in settings' };
    return { ...skipped, syncStateWrite: await heartbeat(service, skipped) };
  }
  const mailboxes: string[] = settings.mailboxes || [];
  if (mailboxes.length === 0) {
    const skipped = { ...result, skipped: 'no mailboxes configured' };
    return { ...skipped, syncStateWrite: await heartbeat(service, skipped) };
  }

  // PO-number context for the classifier and matcher.
  const { data: recentPos } = await service
    .from('netsuite_vendor_pos')
    .select('tranid, vendor_name')
    .order('trandate', { ascending: false })
    .limit(200);
  const knownPos = (recentPos || []).filter(p => p.tranid) as { tranid: string; vendor_name: string | null }[];

  let aiCalls = 0;

  for (const mailbox of mailboxes) {
    result.mailboxes++;
    const gmail = getDelegatedGmail(mailbox);
    let messageIds: string[] = [];
    try {
      const list = await gmail.users.messages.list({ userId: 'me', q: SEARCH_QUERY, maxResults: MAX_MESSAGES_PER_MAILBOX });
      messageIds = (list.data.messages || []).map(m => m.id!).filter(Boolean);
    } catch (e: any) {
      // Mailbox-level failure (bad address, delegation not propagated yet) —
      // record one error row per run window so it surfaces without spamming.
      console.error(`[parts-email] mailbox ${mailbox} list failed:`, e?.message);
      result.errors++;
      continue;
    }
    if (messageIds.length === 0) continue;
    result.candidates += messageIds.length;

    const { data: seen } = await service
      .from('vendor_shipment_emails')
      .select('gmail_id')
      .eq('mailbox', mailbox)
      .in('gmail_id', messageIds);
    const seenIds = new Set((seen || []).map(s => s.gmail_id));
    const fresh = messageIds.filter(id => !seenIds.has(id));

    for (const gmailId of fresh) {
      if (aiCalls >= MAX_AI_CALLS_PER_RUN) break;
      const row: Record<string, unknown> = { mailbox, gmail_id: gmailId };
      try {
        const msg = await gmail.users.messages.get({ userId: 'me', id: gmailId, format: 'full' });
        const from = getHeader(msg.data, 'From');
        const subject = getHeader(msg.data, 'Subject');
        const dateHeader = getHeader(msg.data, 'Date');
        row.from_address = from.slice(0, 300);
        row.subject = subject.slice(0, 500);
        row.received_at = dateHeader ? new Date(dateHeader).toISOString() : null;

        // Internal senders can't be vendor notices; skip without an AI call.
        const fromAddr = (from.match(/<([^>]+)>/)?.[1] || from).toLowerCase();
        if (fromAddr.endsWith('@bmgfleet.com')) {
          await service.from('vendor_shipment_emails').insert({ ...row, classification: 'ignored', summary: 'Internal sender' });
          result.processed++;
          continue;
        }

        const body = getMessagePlainText(msg.data).slice(0, BODY_CHAR_LIMIT);
        aiCalls++;
        const extracted = await classifyEmail(subject, from, body, knownPos);
        if (!extracted) {
          await service.from('vendor_shipment_emails').insert({ ...row, classification: 'error', error: 'ANTHROPIC_API_KEY not set' });
          result.errors++;
          continue;
        }

        row.vendor_name = extracted.vendor_name;
        row.po_number = extracted.po_number;
        row.ship_date = extracted.ship_date;
        row.eta_date = extracted.eta_date;
        row.tracking_number = extracted.tracking_number;
        row.carrier = extracted.carrier;
        row.summary = extracted.summary;

        if (!extracted.is_parts_order_update) {
          await service.from('vendor_shipment_emails').insert({ ...row, classification: 'ignored' });
          result.processed++;
          continue;
        }

        const po = extracted.po_number ? await findPoByNumber(service, extracted.po_number) : null;
        let insertedId: string | null = null;
        if (po) {
          const outcome = await applyEmailToPo(service, extracted, po, subject.slice(0, 120));
          const { data: inserted } = await service.from('vendor_shipment_emails')
            .insert({ ...row, classification: outcome, matched_po_id: po.id })
            .select('id').single();
          insertedId = inserted?.id || null;
          if (outcome === 'applied') result.applied++;
        } else {
          const { data: inserted } = await service.from('vendor_shipment_emails')
            .insert({ ...row, classification: 'review' })
            .select('id').single();
          insertedId = inserted?.id || null;
          result.review++;
        }

        // Invoice emails: pull the PDF(s) into R2 so a bill can be created
        // from the matched PO with one click.
        if (extracted.is_invoice && insertedId) {
          await captureInvoiceAttachments(service, gmail, msg.data, insertedId, mailbox, extracted, po?.id || null);
        }
        result.processed++;
      } catch (e: any) {
        console.error(`[parts-email] ${mailbox}/${gmailId} failed:`, e?.message);
        await service.from('vendor_shipment_emails')
          .insert({ ...row, classification: 'error', error: String(e?.message || e).slice(0, 300) })
          .then(() => {}, () => {});
        result.errors++;
      }
    }
  }

  return { ...result, syncStateWrite: await heartbeat(service, result) };
}
