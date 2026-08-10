import { NextRequest, NextResponse } from 'next/server';
import { getMessage, getPdfAttachments, getAttachment, getHeader } from '@/lib/google';
import { createClient } from '@supabase/supabase-js';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { requireAuth } from '@/lib/api-auth';
import { r2Upload } from '@/lib/r2';
import { resolvePoCustomer } from '@/lib/customer-match';
import { validateBody, z } from '@/lib/validate';
import { isProofLikeName } from '@/lib/pdf-classify';
import { recomputePoFulfillment } from '@/lib/scan-match';
import { fetchAllRows } from '@/lib/fetch-all';
import { notifyPoImported, countGraphicsLines } from '@/lib/po-import-notify';
import { applyInstallPartRule } from '@/lib/po-install-parts';
import { nextJobNumber, legacyJobNumber } from '@/lib/job-numbers';

// Full active catalog for part matching — paginated past PostgREST's
// 1000-row cap. A truncated read here marks real parts "not in catalog"
// on imported PO lines (part_id null, excluded from proof attachment).
async function loadCatalogItems(supabase: any): Promise<{ id: string; part_number: string }[]> {
  const { data } = await fetchAllRows<{ id: string; item_number: string }>((from, to) =>
    supabase.from('netsuite_parts').select('id, item_number').eq('is_active', true).order('id').range(from, to),
  );
  return data.map((p) => ({ id: p.id, part_number: p.item_number }));
}

// PDF download + Claude extraction (with retry/backoff) routinely runs well
// past Vercel's default ~10s ceiling, which 504s the function mid-extraction
// and means the PO never lands. Give it the same headroom as the cron.
export const maxDuration = 60;

const ImportSchema = z.object({
  messageId: z.string().min(1).max(200),
  autoCreate: z.boolean().optional(),
  forceOverwrite: z.boolean().optional(),
  extractOnly: z.boolean().optional(),
  // Cached AI-extracted PO payload from a previous /api/parse-po call. Shape
  // is intentionally loose (parser output evolves) — downstream code reads
  // specific fields with optional access. record(unknown) keeps it open.
  preExtracted: z.record(z.string(), z.any()).optional(),
  // When confirming ONE PO out of a multi-PO email, which source PDF
  // attachment(s) belong to that PO — only those files get attached to it.
  // Absent = all of the email's PDFs (single-PO emails, older clients).
  // Gmail attachment ids are long base64 blobs — regularly 300-700 chars —
  // so the per-id cap must be generous or every confirm 400s.
  attachmentIds: z.array(z.string().min(1).max(4000)).max(50).optional(),
  // Filenames of those same source PDFs. Gmail attachment ids are NOT stable
  // across message fetches, so ids captured at extract time usually won't
  // match the confirm-time fetch — filenames are the reliable key.
  attachmentFilenames: z.array(z.string().min(1).max(500)).max(50).optional(),
});

// Persist a PO's source PDFs to R2 + record po_files rows. Skips a filename
// if it's already attached to that PO so re-imports don't duplicate.
async function savePoFilesToStorage(
  supabase: any,
  poId: string,
  messageId: string,
  pdfs: { filename: string; attachmentId: string; size?: number }[],
  cache?: Map<string, string>,
) {
  for (const pdf of pdfs) {
    try {
      const { data: existing } = await supabase
        .from('po_files')
        .select('id')
        .eq('po_id', poId)
        .eq('file_name', pdf.filename)
        .maybeSingle();
      if (existing) continue;

      const base64 = cache?.get(pdf.attachmentId) || (await getAttachment(messageId, pdf.attachmentId));
      const buffer = Buffer.from(base64, 'base64');
      const safeName = pdf.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `po-pdfs/${poId}/${Date.now()}-${safeName}`;
      const result = await r2Upload('graphics-proofs', path, buffer, 'application/pdf');
      if (!result.success) {
        console.warn('R2 upload failed for PO PDF:', pdf.filename, result.error);
        continue;
      }
      await supabase.from('po_files').insert({
        po_id: poId,
        file_name: pdf.filename,
        file_type: 'application/pdf',
        file_size: buffer.length,
        storage_path: path,
        source: 'email_import',
      });
    } catch (err) {
      console.warn(`Failed to save PO file ${pdf.filename}:`, err);
    }
  }
}

// One gmail_po_imports row exists per email (message_id is unique). A
// multi-PO email is confirmed one PO at a time, so each confirmation merges
// its PO number into the row instead of clobbering the previously imported
// ones.
async function mergedPoNumbers(supabase: any, messageId: string, poNumber: string): Promise<string> {
  const { data } = await supabase
    .from('gmail_po_imports')
    .select('po_number')
    .eq('message_id', messageId)
    .maybeSingle();
  const nums = new Set(
    String(data?.po_number || '').split(',').map((s: string) => s.trim()).filter(Boolean),
  );
  nums.add(String(poNumber));
  return [...nums].join(', ');
}

// Route proof/artwork PDFs from a PO email onto the catalog part they belong
// to (a part_files row, same shape as the parts page's attach-proof), so the
// proof shows up under the part's Files & Proofs automatically. Conservative
// matching: a PDF attaches to a part when the part number appears in the
// filename, or when the file is proof-named and the PO has exactly one
// graphics line (02*/RM*) — or exactly one line — to attach to. Anything
// unmatched simply stays on the PO's own files.
async function attachProofPdfsToParts(
  supabase: any,
  messageId: string,
  lineItems: { part_id?: string; part_number: string | null }[],
  pdfs: { filename: string; attachmentId: string }[],
  cache?: Map<string, string>,
): Promise<number> {
  const parts = lineItems.filter(l => l.part_id && l.part_number) as { part_id: string; part_number: string }[];
  if (parts.length === 0) return 0;

  let attached = 0;
  for (const pdf of pdfs) {
    try {
      const upperName = pdf.filename.toUpperCase();
      let targets = parts.filter(p => upperName.includes(p.part_number.toUpperCase()));
      if (targets.length === 0 && isProofLikeName(pdf.filename)) {
        const graphics = parts.filter(p => /^(02|RM)/i.test(p.part_number));
        if (graphics.length === 1) targets = graphics;
        else if (graphics.length === 0 && parts.length === 1) targets = parts;
      }
      if (targets.length === 0) continue;

      const base64 = cache?.get(pdf.attachmentId) || (await getAttachment(messageId, pdf.attachmentId));
      const buffer = Buffer.from(base64, 'base64');
      for (const target of targets) {
        const { data: existing } = await supabase
          .from('part_files')
          .select('id')
          .eq('part_id', target.part_id)
          .eq('file_name', pdf.filename)
          .maybeSingle();
        if (existing) continue;

        const ext = (pdf.filename.split('.').pop() || 'pdf').toLowerCase();
        const path = `part-files/${target.part_id}/${Date.now()}.${ext}`;
        const up = await r2Upload('graphics-proofs', path, buffer, 'application/pdf');
        if (!up.success) {
          console.warn('R2 upload failed for proof PDF:', pdf.filename, up.error);
          continue;
        }
        await supabase.from('part_files').insert({
          part_id: target.part_id,
          file_name: pdf.filename,
          file_type: 'application/pdf',
          file_size: buffer.length,
          storage_path: path,
        });
        attached++;
      }
    } catch (err) {
      console.warn(`Failed to attach proof ${pdf.filename} to part:`, err);
    }
  }
  return attached;
}

/**
 * Check extracted PO lines for graphic parts (02* or RM*) and create flagged graphics jobs.
 * Sends notifications via in-app, SMS, and email based on each user's preferences.
 */
async function flagGraphicParts(
  supabase: any,
  poId: string,
  poNumber: string,
  customer: string,
  extractedLines: any[],
  createdBy?: string,
) {
  const graphicLines = extractedLines.filter((l: any) => {
    const pn = (l.supplier_part || l.part_number || '').toUpperCase();
    return pn.startsWith('02') || pn.startsWith('RM');
  });

  if (graphicLines.length === 0) return { flaggedCount: 0 };

  // Get existing line item IDs for this PO to link jobs
  const { data: poLineItems } = await supabase
    .from('po_line_items')
    .select('id, part_number')
    .eq('po_id', poId);

  const jobInserts = await Promise.all(graphicLines.map(async (l: any) => {
    const partNum = l.supplier_part || l.part_number;
    const matchedLine = (poLineItems || []).find((pli: any) =>
      pli.part_number?.toUpperCase() === (partNum || '').toUpperCase()
    );
    return {
      po_id: poId,
      po_line_item_id: matchedLine?.id || null,
      job_number: await nextJobNumber(supabase, 'GFX', () => legacyJobNumber.gfx()),
      title: l.description || `Graphic - ${partNum}`,
      part_number: partNum,
      customer: customer || null,
      quantity: parseInt(l.quantity) || 1,
      status: 'flagged',
      priority: 'normal',
      created_by: createdBy || null,
    };
  }));

  const { data: createdJobs } = await supabase
    .from('graphics_jobs')
    .insert(jobInserts)
    .select('id, title, job_number');

  // Log status history
  if (createdJobs && createdJobs.length > 0) {
    await supabase.from('graphics_status_history').insert(
      createdJobs.map((j: any) => ({
        job_id: j.id,
        from_status: null,
        to_status: 'flagged',
        changed_by: createdBy || null,
        note: `Auto-flagged from PO #${poNumber}`,
      }))
    );

    // Notify users who want new job alerts (via in-app, SMS, email per their prefs)
    const { data: prefs } = await supabase
      .from('notification_preferences')
      .select('user_id, notify_new_job');

    if (prefs) {
      const notifyUserIds = prefs
        .filter((p: any) => p.notify_new_job && p.user_id !== createdBy)
        .map((p: any) => p.user_id);

      if (notifyUserIds.length > 0) {
        for (const job of createdJobs) {
          await notifyMany(notifyUserIds, {
            type: 'graphics_flagged',
            title: `Graphics Job Flagged: ${job.title}`,
            body: `PO #${poNumber} (${customer}) has a graphic part that needs review`,
            url: deepLinks.graphicsJob(job.id),
          });
        }
      }
    }
  }

  return { flaggedCount: graphicLines.length, flaggedJobs: createdJobs || [] };
}

// Convert a date to ISO YYYY-MM-DD for Postgres DATE columns. Accepts MM/DD/YY,
// MM/DD/YYYY, or already-ISO strings; returns null if we can't parse it.
function normalizeDate(d: string | null | undefined): string | null {
  if (!d) return null;
  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const mo = m[1].padStart(2, '0');
  const day = m[2].padStart(2, '0');
  const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${yr}-${mo}-${day}`;
}

// Pick the earliest delivery date across line items as a fallback when the PO
// has no header-level requested delivery date.
function earliestLineDeliveryDate(lines: any[]): string | null {
  const dates = (lines || [])
    .map(l => normalizeDate(l?.delivery_date))
    .filter((d): d is string => !!d)
    .sort();
  return dates[0] || null;
}

async function callAnthropicWithRetry(body: any, apiKey: string, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25',
      },
      body: JSON.stringify(body),
    });

    // If rate limited (429) or server error (529 overloaded), retry with backoff
    if ((res.status === 429 || res.status === 529) && attempt < maxRetries - 1) {
      const retryAfter = res.headers.get('retry-after');
      const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : Math.min(2000 * Math.pow(2, attempt), 30000);
      console.log(`Anthropic API ${res.status}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    return res;
  }

  // Should not reach here, but just in case
  throw new Error('Max retries exceeded for Anthropic API');
}

const PO_EXTRACTION_PROMPT = `You are extracting purchase order data from a PDF document. This is typically a Masterack or similar fleet equipment purchase order sent to BMG Fleet Installation.

CRITICAL: You MUST extract every single line item from the table. Each line item row has: a line number (like 1.000, 2.000), a part number, a description, quantity, unit of measure (EA/PC), and a unit price. Some POs have many line items across multiple pages — extract ALL of them.

LOOK FOR THESE SPECIFIC ELEMENTS:
- PURCHASE ORDER NUMBER: Usually at top right, labeled "PURCHASE ORDER NUMBER" followed by a number like 35045953
- ORDERED DATE: Format like MM/DD/YY or MM/DD/YYYY
- REQUESTED DELIVERY DATE: A header-level date the buyer needs the order delivered by. On Masterack POs it is labeled exactly "REQUESTED DELIVERY DATE". If that header field is not present, use the earliest delivery date across the line items.
- SHIP TO / DELIVER TO: The address block showing the DESTINATION where items should be delivered. IMPORTANT: POs have multiple address blocks — there is usually a "Supplier" or "Vendor" address (this is BMG Fleet Installation's address — IGNORE IT) and a "Ship To" or "Deliver To" address (this is the actual destination — USE THIS ONE). Never use BMG Fleet Installation's own address as the ship_to. The ship_to should be the customer's facility or job site, like a Masterack plant, dealership, or fleet location.
- LINE ITEMS TABLE: Each row starts with a line number (1.000, 2.000, etc.) followed by columns of data

COLUMN IDENTIFICATION — THIS IS CRITICAL:
The PO table has multiple columns that contain part-number-like codes. You MUST use the correct columns:
- "Item Number" (also labeled "Part Number", "Supplier Part Number", or a stacked "Part Number / Supplier Part Number") column: this is the SECOND column, immediately right of the line number and immediately LEFT of the description. THIS IS THE ONLY COLUMN PART NUMBERS COME FROM. Use its value for part_number.
- "Supplier Part" row below a line item: This is BMG's part number. Use this for supplier_part.
- "Drawing Number" or "Drawing Number & Revision" column: the LAST column, to the RIGHT of the description. Put its value in drawing_number and NOWHERE ELSE. It is never part_number and never supplier_part.
- "Revision" column: put nothing from it anywhere. Revision numbers are NOT part numbers.

THE DRAWING COLUMN IS A TRAP — it holds a code that looks exactly like a part
number. On these POs the drawing number is usually the SAME suffix as the
item number with a DIFFERENT prefix. Real example, one row:
  Line No. 1.000 | Item Number 06U233 | Description INSTALL DCL VERIZON VZT 2026 CHEVY EXPRESS | Drawing Number & Revision 02U233
The correct part_number for that row is 06U233 (left of the description).
02U233 is the DRAWING number (right of the description) and goes only in
drawing_number. Taking 02U233 as the part number is WRONG and is the single
most common mistake on this document. Before you write each line's
part_number, confirm you read it from the column LEFT of the description,
not the one on the far right.

02 vs 06 PREFIXES — READ THE DIGITS CAREFULLY:
Item numbers start with a two-digit prefix that says what the line is:
- "02…" is a PHYSICAL PART (a graphic kit, rack, shelf, partition — something shipped).
- "06…" is the INSTALLATION CHARGE for that part (labor, not a shipped item).
A part and its install share the same suffix — 02T278 is the part, 06T278 is
installing it — so the prefix is the ONLY thing that tells them apart, and a
PO usually lists both, one after the other. Do not guess and do not copy the
prefix from a neighboring row: read each row's own digits.

HARD RULE: if a line's description says INSTALL (install, installs,
installed, installation, INSTL, INST), that line's item number ALWAYS starts
with 06 — never 02. A line described as an install with an 02 number is a
misread. Likewise a description with no install wording is the physical part
and normally starts with 02.

Return ONLY valid JSON, no markdown, no backticks, no other text:
{
  "po_number": "35045953",
  "customer": "Masterack",
  "ordered_date": "03/18/2026",
  "requested_delivery_date": "03/25/2026",
  "ship_to": {
    "name": "Masterack - Kansas City",
    "address": "1234 Industrial Blvd",
    "city": "Kansas City",
    "state": "MO",
    "zip": "64101"
  },
  "lines": [
    {
      "line_no": "1.000",
      "part_number": "02T278",
      "supplier_part": "02T278",
      "drawing_number": "06T278",
      "description": "GRAPHIC KIT-FORD TRANSIT",
      "quantity": 10,
      "unit_price": 45.00,
      "delivery_date": "03/25/2026"
    },
    {
      "line_no": "2.000",
      "part_number": "06T278",
      "supplier_part": "06T278",
      "drawing_number": "02T278",
      "description": "INSTALL GRAPHIC KIT-FORD TRANSIT",
      "quantity": 10,
      "unit_price": 22.00,
      "delivery_date": "03/25/2026"
    }
  ],
  "notes": null
}

RULES:
- Extract EVERY line item row — do not skip any
- part_number: The Masterack/buyer part number from the "Item Number" column, LEFT of the description (e.g., RM530432, 02T278, 06T278). This is the PRIMARY identifier.
- supplier_part: BMG's supplier part number, often shown on the line below the main item row. If not present, copy part_number.
- drawing_number: The "Drawing Number & Revision" value from the far-right column, or null if the PO has no such column. Extract it into this field so it can never be confused with the part number. Never reuse it as part_number or supplier_part.
- Before returning, re-check every line twice: (1) its part_number came from the column LEFT of the description, not the drawing column on the right — if part_number and drawing_number came out identical you read the same column twice and must re-read the row; (2) if the description mentions install, part_number and supplier_part start with 06, not 02.
- quantity: Integer only
- unit_price: Decimal number, no $ sign (e.g., 45.00)
- delivery_date: The requested delivery date for that line, if shown
- If the PO has items across multiple pages, include ALL pages
- customer: Usually "Masterack" for Masterack POs. Use the buyer/company name from the header`;

type ExtractResult =
  | { ok: true; extracted: any; stopReason: string | null; inputTokens: number; outputTokens: number }
  | { ok: false; kind: 'api'; status: number; errBody: string }
  | { ok: false; kind: 'parse'; raw: string };

// Run one Claude extraction over one PDF (or a set treated as one document).
// Returns the parsed JSON plus response metadata, or a typed failure so the
// caller can distinguish API errors from unparseable output.
async function extractFromPdfs(base64Docs: string[], promptSuffix: string, apiKey: string): Promise<ExtractResult> {
  const res = await callAnthropicWithRetry({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: [
        ...base64Docs.map(data => ({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data },
        })),
        { type: 'text', text: PO_EXTRACTION_PROMPT + promptSuffix },
      ],
    }],
  }, apiKey);

  if (!res.ok) {
    return { ok: false, kind: 'api', status: res.status, errBody: await res.text() };
  }

  const aiResult = await res.json();
  const aiText = aiResult.content?.[0]?.text || '';
  try {
    // Find JSON in the response, handling potential markdown wrapping
    let jsonStr = aiText;
    const codeBlockMatch = aiText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1];
    } else {
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      if (jsonMatch) jsonStr = jsonMatch[0];
    }
    const extracted = JSON.parse(jsonStr);
    // The prompt states the 02/06 rule, but a misread digit is exactly the
    // kind of thing a model gets wrong occasionally — and it's cheap to
    // settle deterministically: a line described as an install is always an
    // 06. Corrected lines carry install_prefix_corrected so the review panel
    // can show what changed instead of quietly editing the PO.
    if (Array.isArray(extracted?.lines)) {
      const { lines, correctedCount } = applyInstallPartRule(extracted.lines);
      extracted.lines = lines;
      if (correctedCount > 0) {
        console.log(`PO extraction: corrected ${correctedCount} install line(s) from 02 to 06`);
      }
    }
    return {
      ok: true,
      extracted,
      stopReason: aiResult.stop_reason || null,
      inputTokens: aiResult.usage?.input_tokens || 0,
      outputTokens: aiResult.usage?.output_tokens || 0,
    };
  } catch {
    return { ok: false, kind: 'parse', raw: aiText };
  }
}

export async function POST(req: NextRequest) {
  // Allow internal server-to-server calls (from auto-import cron)
  const authHeader = req.headers.get('authorization');
  const isInternalCall = authHeader === `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`;
  // Who confirmed this import. Stays null for the cron's server-to-server
  // calls, which is what keeps the "imported by" alert to human imports only.
  let actorId: string | null = null;
  if (!isInternalCall) {
    const auth = await requireAuth(req);
    if (auth.error) return auth.error;
    actorId = auth.user?.id || null;
  }

  const parsed = await validateBody(req, ImportSchema);
  if (parsed.error) return parsed.error;
  const { messageId, autoCreate, forceOverwrite, extractOnly, preExtracted, attachmentIds, attachmentFilenames } = parsed.data;

  try {

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Get the message metadata
    const message = await getMessage(messageId);
    const subject = getHeader(message, 'Subject');
    const from = getHeader(message, 'From');
    const date = getHeader(message, 'Date');
    const pdfs = getPdfAttachments(message);

    // If preExtracted data is provided (user reviewed/edited the extraction), skip Claude and use it directly
    if (preExtracted) {
      const extracted = preExtracted;
      const poNumber = extracted.po_number;
      if (!poNumber) {
        return NextResponse.json({ error: 'No PO number in edited data' }, { status: 400 });
      }
      const extractedLines = (extracted.lines || []).filter((l: any) => l.part_number);
      const pdfFilenames = pdfs.map((p: any) => p.filename).join(', ');
      // Only this PO's source PDFs get attached when the caller scoped them
      // (multi-PO email confirmed one PO at a time); default is all PDFs.
      // Match by filename OR attachment id: the message was just re-fetched,
      // and Gmail issues fresh attachment ids per fetch, so ids the client
      // captured at extract time usually match nothing. If the scoped filter
      // still comes up empty, attach every PDF — over-attaching beats the PO
      // silently getting no files at all.
      const wantIds = new Set(attachmentIds || []);
      const wantNames = new Set((attachmentFilenames || []).map(n => n.toLowerCase()));
      let poPdfs = (wantIds.size || wantNames.size)
        ? pdfs.filter(p => wantIds.has(p.attachmentId) || wantNames.has(p.filename.toLowerCase()))
        : pdfs;
      if (poPdfs.length === 0) poPdfs = pdfs;

      // From here, proceed to PO creation logic (same as normal flow)
      // Check if PO already exists
      const { data: existingPO } = await supabase
        .from('purchase_orders')
        .select('*, po_line_items(*)')
        .eq('po_number', String(poNumber))
        .maybeSingle();

      if (existingPO && !forceOverwrite) {
        return NextResponse.json({
          status: 'exists',
          poNumber,
          poId: existingPO.id,
          existingLineCount: (existingPO.po_line_items || []).length,
          newLineCount: extractedLines.length,
          changes: [],
          hasChanges: true,
          extracted,
        });
      }

      if (existingPO && forceOverwrite) {
        await supabase.from('po_line_items').delete().eq('po_id', existingPO.id);

        // Resolve the extracted name to a real NetSuite customer (canonical
        // name + internal id) so it flows through to downstream transactions.
        const { customer, customerNetsuiteId } = await resolvePoCustomer(
          supabase, extracted.customer || existingPO.customer
        );
        const requestedDelivery =
          normalizeDate(extracted.requested_delivery_date) ||
          earliestLineDeliveryDate(extractedLines) ||
          existingPO.requested_delivery_date ||
          null;
        await supabase.from('purchase_orders').update({
          customer,
          customer_netsuite_id: customerNetsuiteId || existingPO.customer_netsuite_id || null,
          ordered_date: normalizeDate(extracted.ordered_date) || existingPO.ordered_date || null,
          requested_delivery_date: requestedDelivery,
          notes: extracted.notes ? String(extracted.notes) : existingPO.notes,
          ship_to: extracted.ship_to || existingPO.ship_to || null,
        }).eq('id', existingPO.id);

        const catalogItems = await loadCatalogItems(supabase);

        const lineInserts = extractedLines.map((l: any) => {
          const partNum = l.supplier_part || l.part_number;
          const catalogMatch = catalogItems.find((c: any) =>
            c.part_number.toUpperCase() === (partNum || '').toUpperCase() ||
            c.part_number.toUpperCase() === (l.part_number || '').toUpperCase()
          );
          return {
            po_id: existingPO.id,
            ...(catalogMatch?.id ? { part_id: catalogMatch.id } : {}),
            part_number: partNum,
            description: l.description || null,
            quantity: parseInt(l.quantity) || 0,
            unit_price: parseFloat(l.unit_price) || 0,
          };
        });

        if (lineInserts.length > 0) {
          await supabase.from('po_line_items').insert(lineInserts);
        }

        // Replaced lines reset installed counts — re-derive open/complete so
        // a previously fulfilled PO reopens when the update adds work.
        await recomputePoFulfillment(supabase, [existingPO.id]);

        await savePoFilesToStorage(supabase, existingPO.id, messageId, poPdfs);
        // Part matching sees every PDF on the email — proofs are deliberately
        // excluded from the PO's own files but still belong on their part.
        const proofsAttached = await attachProofPdfsToParts(supabase, messageId, lineInserts, pdfs);

        await supabase.from('gmail_po_imports').upsert({
          message_id: messageId, thread_id: message.threadId, subject, from_email: from,
          received_at: date ? new Date(date).toISOString() : null,
          po_number: await mergedPoNumbers(supabase, messageId, String(poNumber)), po_id: existingPO.id,
          attachment_filename: pdfFilenames, status: 'imported', raw_extraction: extracted,
        }, { onConflict: 'message_id' });

        const unmatchedParts = extractedLines
          .filter((l: any) => {
            const partNum = l.supplier_part || l.part_number;
            return !catalogItems.find((c: any) =>
              c.part_number.toUpperCase() === (partNum || '').toUpperCase() ||
              c.part_number.toUpperCase() === (l.part_number || '').toUpperCase()
            );
          })
          .map((l: any) => ({ part_number: l.supplier_part || l.part_number, description: l.description || '', unit_price: parseFloat(l.unit_price) || 0 }));

        await notifyPoImported(supabase, {
          poId: existingPO.id,
          poNumber: String(poNumber),
          customer,
          lineCount: lineInserts.length,
          graphicsCount: countGraphicsLines(lineInserts),
          updated: true,
          actorId,
        });

        return NextResponse.json({ status: 'updated', poNumber, poId: existingPO.id, customer, lineCount: lineInserts.length, unmatchedParts, extracted, proofsAttached });
      }

      // Create new PO from reviewed data
      const catalogItems = await loadCatalogItems(supabase);
      const { customer, customerNetsuiteId } = await resolvePoCustomer(supabase, extracted.customer);

      const { data: adminUser } = await supabase.from('profiles').select('id').eq('role', 'admin').limit(1).single();
      const insertPayload: any = {
        po_number: String(poNumber), customer,
        customer_netsuite_id: customerNetsuiteId,
        ordered_date: normalizeDate(extracted.ordered_date),
        requested_delivery_date:
          normalizeDate(extracted.requested_delivery_date) ||
          earliestLineDeliveryDate(extractedLines),
        notes: extracted.notes ? String(extracted.notes) : null,
        ship_to: extracted.ship_to || null,
      };
      if (adminUser?.id) insertPayload.created_by = adminUser.id;

      const { data: newPO, error: poError } = await supabase.from('purchase_orders').insert(insertPayload).select().single();
      if (poError || !newPO) {
        return NextResponse.json({ error: 'Failed to create PO', details: poError?.message }, { status: 500 });
      }

      const lineInserts = extractedLines.map((l: any) => {
        const partNum = l.supplier_part || l.part_number;
        const catalogMatch = catalogItems.find((c: any) =>
          c.part_number.toUpperCase() === (partNum || '').toUpperCase() ||
          c.part_number.toUpperCase() === (l.part_number || '').toUpperCase()
        );
        return {
          po_id: newPO.id,
          ...(catalogMatch?.id ? { part_id: catalogMatch.id } : {}),
          part_number: partNum,
          description: l.description || null,
          quantity: parseInt(l.quantity) || 0,
          unit_price: parseFloat(l.unit_price) || 0,
        };
      });

      if (lineInserts.length > 0) {
        await supabase.from('po_line_items').insert(lineInserts);
      }

      await savePoFilesToStorage(supabase, newPO.id, messageId, poPdfs);
      const proofsAttached = await attachProofPdfsToParts(supabase, messageId, lineInserts, pdfs);

      await supabase.from('gmail_po_imports').upsert({
        message_id: messageId, thread_id: message.threadId, subject, from_email: from,
        received_at: date ? new Date(date).toISOString() : null,
        po_number: await mergedPoNumbers(supabase, messageId, String(poNumber)), po_id: newPO.id,
        attachment_filename: pdfFilenames, status: 'imported', raw_extraction: extracted,
      }, { onConflict: 'message_id' });

      const unmatchedParts = extractedLines
        .filter((l: any) => {
          const partNum = l.supplier_part || l.part_number;
          return !catalogItems.find((c: any) =>
            c.part_number.toUpperCase() === (partNum || '').toUpperCase() ||
            c.part_number.toUpperCase() === (l.part_number || '').toUpperCase()
          );
        })
        .map((l: any) => ({ part_number: l.supplier_part || l.part_number, description: l.description || '', unit_price: parseFloat(l.unit_price) || 0 }));

      await notifyPoImported(supabase, {
        poId: newPO.id,
        poNumber: String(poNumber),
        customer,
        lineCount: lineInserts.length,
        graphicsCount: countGraphicsLines(lineInserts),
        actorId,
      });

      return NextResponse.json({ status: 'imported', poNumber, poId: newPO.id, customer, lineCount: lineInserts.length, unmatchedParts, extracted, proofsAttached });
    }

    if (pdfs.length === 0) {
      return NextResponse.json({ error: 'No PDF attachment found' }, { status: 400 });
    }

    // Sort: filenames containing "PO" or "purchase" first, then by size descending
    const sortedPdfs = [...pdfs].sort((a, b) => {
      const aIsPO = /\b(po|purchase.?order)\b/i.test(a.filename) ? 1 : 0;
      const bIsPO = /\b(po|purchase.?order)\b/i.test(b.filename) ? 1 : 0;
      if (aIsPO !== bIsPO) return bIsPO - aIsPO;
      return b.size - a.size;
    });

    // Download every PDF once; base64 is reused for extraction AND the R2
    // upload so attachments aren't fetched from Gmail twice.
    const downloaded: { pdf: (typeof sortedPdfs)[number]; base64: string }[] = [];
    for (const pdf of sortedPdfs) {
      try {
        downloaded.push({ pdf, base64: await getAttachment(messageId, pdf.attachmentId) });
      } catch (err) {
        console.warn(`Failed to download attachment ${pdf.filename}:`, err);
      }
    }

    if (downloaded.length === 0) {
      return NextResponse.json({ error: 'Failed to download any PDF attachments' }, { status: 400 });
    }
    const pdfCache = new Map(downloaded.map(d => [d.pdf.attachmentId, d.base64] as const));
    const pdfFilenames = downloaded.map(d => d.pdf.filename);

    // Extract. A single attachment keeps the original one-call flow. With
    // several attachments, each PDF is extracted SEPARATELY — an email often
    // carries multiple DIFFERENT purchase orders (plus spec sheets/BOLs), and
    // a combined call can only ever return one of them.
    type PdfRef = { filename: string; attachmentId: string; size: number };
    const poExtractions: {
      extracted: any;
      pdfs: PdfRef[];
      meta: { stopReason: string | null; inputTokens: number; outputTokens: number };
    }[] = [];
    const supportingPdfs: PdfRef[] = [];
    // Proof/artwork files live in their own bucket: they never enter the
    // review flow or the PO's files — they only go to part matching below.
    const proofPdfs: PdfRef[] = [];
    let firstApiFailure: { status: number; errBody: string } | null = null;
    let firstParseFailure: { raw: string } | null = null;

    if (downloaded.length === 1) {
      const r = await extractFromPdfs([downloaded[0].base64], '', process.env.ANTHROPIC_API_KEY!);
      if (!r.ok) {
        if (r.kind === 'api') firstApiFailure = r;
        else firstParseFailure = r;
      } else if (!r.extracted?.po_number) {
        return NextResponse.json({ error: 'No PO number found in PDF', extracted: r.extracted }, { status: 400 });
      } else {
        poExtractions.push({ extracted: r.extracted, pdfs: [downloaded[0].pdf], meta: r });
      }
    } else {
      // Proof/artwork PDFs are image-heavy: running one through extraction is
      // slow enough to time out the whole import, and it is never the PO.
      // Classify them by name (unless the name also says it IS a PO) or by
      // any size no text PO ever reaches, so they skip the AI call entirely.
      const EXTRACT_MAX_BYTES = 4 * 1024 * 1024;
      const extractable: typeof downloaded = [];
      for (const d of downloaded) {
        const approxBytes = d.base64.length * 0.75;
        if (isProofLikeName(d.pdf.filename) || approxBytes > EXTRACT_MAX_BYTES) {
          proofPdfs.push(d.pdf);
        } else {
          extractable.push(d);
        }
      }

      const NOT_A_PO_NOTE = `\n\nIMPORTANT: This document is ONE attachment from an email that may contain several attachments, possibly including MULTIPLE separate purchase orders. Extract ONLY this document. If this document is NOT a purchase order, return exactly: {"not_a_po": true, "document_type": "<one of: proof, spec, drawing, bol, invoice, packing_list, quote, other>"} — a proof/artwork/graphics rendering of a vehicle or product is document_type "proof".`;
      const results = await Promise.all(
        extractable.map(d => extractFromPdfs([d.base64], NOT_A_PO_NOTE, process.env.ANTHROPIC_API_KEY!)),
      );
      results.forEach((r, i) => {
        const pdf = extractable[i].pdf;
        if (!r.ok) {
          if (r.kind === 'api') firstApiFailure = firstApiFailure || r;
          else firstParseFailure = firstParseFailure || r;
          console.warn(`PO extraction failed for attachment ${pdf.filename}`);
          return;
        }
        // Not a PO — or a PO-shaped extraction with no usable lines (proofs
        // and quotes sometimes carry a PO reference number): supporting file,
        // with proofs kept in their own bucket.
        const hasUsableLines = (r.extracted?.lines || []).some((l: any) => l.part_number);
        if (r.extracted?.not_a_po || !r.extracted?.po_number || !hasUsableLines) {
          if (/proof/i.test(String(r.extracted?.document_type || ''))) proofPdfs.push(pdf);
          else supportingPdfs.push(pdf);
          return;
        }
        // Same PO number from two attachments (duplicate/split PDF): keep one
        // extraction and carry both files.
        const existing = poExtractions.find(pe => String(pe.extracted.po_number) === String(r.extracted.po_number));
        if (existing) {
          existing.pdfs.push(pdf);
          return;
        }
        poExtractions.push({ extracted: r.extracted, pdfs: [pdf], meta: r });
      });
    }

    // Non-PO paperwork (spec sheets, BOLs, drawings) rides along with every
    // PO found. Proofs deliberately do NOT — they'd show up in the review
    // panel and clutter the PO's files; they go to part matching instead.
    for (const pe of poExtractions) pe.pdfs.push(...supportingPdfs);

    if (poExtractions.length === 0) {
      if (firstApiFailure) {
        console.error('Anthropic API error:', firstApiFailure.errBody);
        await supabase.from('gmail_po_imports').upsert({
          message_id: messageId,
          thread_id: message.threadId,
          subject,
          from_email: from,
          received_at: date ? new Date(date).toISOString() : null,
          attachment_filename: pdfFilenames.join(', '),
          status: 'error',
          error_message: `AI extraction failed: ${firstApiFailure.status}`,
        }, { onConflict: 'message_id' });
        return NextResponse.json({ error: 'AI extraction failed', details: firstApiFailure.errBody }, { status: 500 });
      }
      if (firstParseFailure) {
        await supabase.from('gmail_po_imports').upsert({
          message_id: messageId,
          thread_id: message.threadId,
          subject,
          from_email: from,
          received_at: date ? new Date(date).toISOString() : null,
          attachment_filename: pdfFilenames.join(', '),
          status: 'error',
          error_message: 'Failed to parse AI extraction',
          raw_extraction: { raw: firstParseFailure.raw },
        }, { onConflict: 'message_id' });
        return NextResponse.json({ error: 'Failed to parse extraction', raw: firstParseFailure.raw }, { status: 500 });
      }
      return NextResponse.json({ error: 'No PO number found in any PDF attachment' }, { status: 400 });
    }

    // Multiple distinct POs in one email: hand ALL of them to the review flow
    // so each gets confirmed (and its own PDF attached) individually.
    if (poExtractions.length > 1) {
      const poNumbers = poExtractions.map(pe => String(pe.extracted.po_number));

      if (!extractOnly) {
        // Blind bulk-create of several POs is easy to get wrong — require the
        // review flow (every current caller already uses it).
        return NextResponse.json({
          error: `This email contains ${poExtractions.length} purchase orders (${poNumbers.join(', ')}). Import it via review so each PO can be confirmed individually.`,
          poNumbers,
        }, { status: 422 });
      }

      await supabase.from('gmail_po_imports').upsert({
        message_id: messageId,
        thread_id: message.threadId,
        subject,
        from_email: from,
        received_at: date ? new Date(date).toISOString() : null,
        po_number: poNumbers.join(', '),
        attachment_filename: pdfFilenames.join(', '),
        status: 'pending',
        // Keep each PO's own source PDFs so a review opened later from the
        // pending list can rebuild the same per-PO queue the live flow shows.
        raw_extraction: { multi: true, pos: poExtractions.map(pe => ({ extracted: pe.extracted, pdfs: pe.pdfs })) },
      }, { onConflict: 'message_id' });

      return NextResponse.json({
        status: 'review',
        multi: true,
        poNumber: poNumbers.join(', '),
        customer: poExtractions[0].extracted.customer || 'Unknown',
        // One review entry per PO, each with its own source PDF(s) so the
        // client can queue them through the review panel one at a time.
        reviews: poExtractions.map(pe => ({
          poNumber: pe.extracted.po_number,
          customer: pe.extracted.customer || 'Unknown',
          ordered_date: pe.extracted.ordered_date || null,
          extracted: pe.extracted,
          pdfs: pe.pdfs,
        })),
      });
    }

    // Exactly one PO — original single-PO flow from here down.
    const { extracted, meta } = poExtractions[0];
    const poPdfs = poExtractions[0].pdfs;
    const poNumber = extracted.po_number;

    const extractedLines = (extracted.lines || []).filter((l: any) => l.part_number);

    // Validate extraction quality — catch partial/degraded extractions
    const hasLines = extractedLines.length > 0;
    const hasPricing = extractedLines.some((l: any) => parseFloat(l.unit_price) > 0);
    const stopReason = meta.stopReason;
    const inputTokens = meta.inputTokens;
    const outputTokens = meta.outputTokens;

    console.log(`PO ${poNumber}: extracted ${extractedLines.length} lines, hasPricing=${hasPricing}, stopReason=${stopReason}, tokens=${inputTokens}/${outputTokens}`);

    if (stopReason === 'max_tokens') {
      console.warn(`PO ${poNumber}: AI response hit max_tokens — extraction may be truncated`);
    }

    if (!hasLines) {
      await supabase.from('gmail_po_imports').upsert({
        message_id: messageId,
        thread_id: message.threadId,
        subject,
        from_email: from,
        received_at: date ? new Date(date).toISOString() : null,
        po_number: String(poNumber),
        attachment_filename: pdfFilenames.join(', '),
        status: 'error',
        error_message: 'AI extracted PO number but no line items — possible rate limit or degraded response',
        raw_extraction: extracted,
      }, { onConflict: 'message_id' });

      return NextResponse.json({
        error: `Extracted PO #${poNumber} but no line items were found. This may be due to API rate limiting — try again in a moment.`,
        extracted,
        warning: 'partial_extraction',
      }, { status: 422 });
    }

    // Note: $0.00 pricing is allowed — some POs arrive without pricing and can be edited after import
    if (!hasPricing && hasLines) {
      console.log(`PO ${poNumber}: all prices are $0.00 — proceeding (pricing can be added after import)`);
    }

    // If extractOnly mode, return the extracted data for user review/editing — don't create anything
    if (extractOnly) {
      await supabase.from('gmail_po_imports').upsert({
        message_id: messageId,
        thread_id: message.threadId,
        subject,
        from_email: from,
        received_at: date ? new Date(date).toISOString() : null,
        po_number: String(poNumber),
        attachment_filename: pdfFilenames.join(', '),
        status: 'pending',
        raw_extraction: extracted,
      }, { onConflict: 'message_id' });

      return NextResponse.json({
        status: 'review',
        poNumber,
        customer: extracted.customer || 'Unknown',
        ordered_date: extracted.ordered_date || null,
        extracted,
        // Attachment refs (the PO's own PDF first) so the review UI can show
        // the source PDF next to the extracted fields
        pdfs: poPdfs.map(p => ({ filename: p.filename, attachmentId: p.attachmentId, size: p.size })),
      });
    }

    // Check if PO already exists
    const { data: existingPO } = await supabase
      .from('purchase_orders')
      .select('*, po_line_items(*)')
      .eq('po_number', String(poNumber))
      .maybeSingle();

    if (existingPO && !forceOverwrite) {
      // Build a diff of what changed
      const existingLines = existingPO.po_line_items || [];
      const changes: any[] = [];

      // Check for new or changed lines
      for (const newLine of extractedLines) {
        const match = existingLines.find((el: any) =>
          el.part_number?.toUpperCase() === (newLine.part_number || '').toUpperCase() ||
          el.part_number?.toUpperCase() === (newLine.supplier_part || '').toUpperCase()
        );
        if (!match) {
          changes.push({
            type: 'added',
            part_number: newLine.supplier_part || newLine.part_number,
            description: newLine.description,
            quantity: parseInt(newLine.quantity) || 0,
            unit_price: parseFloat(newLine.unit_price) || 0,
          });
        } else {
          const newQty = parseInt(newLine.quantity) || 0;
          const newPrice = parseFloat(newLine.unit_price) || 0;
          const qtyChanged = newQty !== match.quantity;
          const priceChanged = Math.abs(newPrice - match.unit_price) > 0.001;
          if (qtyChanged || priceChanged) {
            changes.push({
              type: 'changed',
              part_number: match.part_number,
              description: newLine.description,
              old_quantity: match.quantity,
              new_quantity: newQty,
              old_price: match.unit_price,
              new_price: newPrice,
              quantity_changed: qtyChanged,
              price_changed: priceChanged,
            });
          }
        }
      }

      // Check for removed lines
      for (const existingLine of existingLines) {
        const stillExists = extractedLines.find((nl: any) =>
          (nl.part_number || '').toUpperCase() === existingLine.part_number?.toUpperCase() ||
          (nl.supplier_part || '').toUpperCase() === existingLine.part_number?.toUpperCase()
        );
        if (!stillExists) {
          changes.push({
            type: 'removed',
            part_number: existingLine.part_number,
            quantity: existingLine.quantity,
            unit_price: existingLine.unit_price,
          });
        }
      }

      // Record extraction
      await supabase.from('gmail_po_imports').upsert({
        message_id: messageId,
        thread_id: message.threadId,
        subject,
        from_email: from,
        received_at: date ? new Date(date).toISOString() : null,
        po_number: String(poNumber),
        po_id: existingPO.id,
        attachment_filename: pdfFilenames.join(', '),
        status: 'pending',
        raw_extraction: extracted,
      }, { onConflict: 'message_id' });

      return NextResponse.json({
        status: 'exists',
        poNumber,
        poId: existingPO.id,
        existingLineCount: existingLines.length,
        newLineCount: extractedLines.length,
        changes,
        hasChanges: changes.length > 0,
        extracted,
      });
    }

    // Overwrite existing PO if forceOverwrite is true
    if (existingPO && forceOverwrite) {
      // Delete old line items
      const { error: deleteErr } = await supabase.from('po_line_items').delete().eq('po_id', existingPO.id);
      if (deleteErr) {
        console.error('Failed to delete old line items:', deleteErr);
        return NextResponse.json({ error: `Failed to update PO: ${deleteErr.message}` }, { status: 500 });
      }

      // Update PO header, resolving the customer to a real NetSuite customer
      // (canonical name + internal id).
      const { customer, customerNetsuiteId } = await resolvePoCustomer(
        supabase, extracted.customer || existingPO.customer
      );
      const requestedDelivery =
        normalizeDate(extracted.requested_delivery_date) ||
        earliestLineDeliveryDate(extractedLines) ||
        existingPO.requested_delivery_date ||
        null;
      const { error: updateErr } = await supabase.from('purchase_orders').update({
        customer,
        customer_netsuite_id: customerNetsuiteId || existingPO.customer_netsuite_id || null,
        ordered_date: normalizeDate(extracted.ordered_date) || existingPO.ordered_date || null,
        requested_delivery_date: requestedDelivery,
        notes: extracted.notes ? String(extracted.notes) : existingPO.notes,
        ship_to: extracted.ship_to || existingPO.ship_to || null,
      }).eq('id', existingPO.id);
      if (updateErr) {
        console.error('Failed to update PO header:', updateErr);
      }

      // Get catalog for part matching
      const catalogItems = await loadCatalogItems(supabase);

      // Insert new line items
      const lineInserts = extractedLines.map((l: any) => {
        const partNum = l.supplier_part || l.part_number;
        const catalogMatch = catalogItems.find((c: any) =>
          c.part_number.toUpperCase() === (partNum || '').toUpperCase() ||
          c.part_number.toUpperCase() === (l.part_number || '').toUpperCase()
        );
        return {
          po_id: existingPO.id,
          ...(catalogMatch?.id ? { part_id: catalogMatch.id } : {}),
          part_number: partNum,
          description: l.description || null,
          quantity: parseInt(l.quantity) || 0,
          unit_price: parseFloat(l.unit_price) || 0,
        };
      });

      if (lineInserts.length > 0) {
        const { error: insertErr } = await supabase.from('po_line_items').insert(lineInserts);
        if (insertErr) {
          console.error('Failed to insert new line items:', insertErr);
          return NextResponse.json({ error: `Failed to insert updated line items: ${insertErr.message}` }, { status: 500 });
        }
      }

      // Replaced lines reset installed counts — re-derive open/complete so a
      // previously fulfilled PO reopens when the update adds work.
      await recomputePoFulfillment(supabase, [existingPO.id]);

      await savePoFilesToStorage(supabase, existingPO.id, messageId, poPdfs, pdfCache);
      const proofsAttached = await attachProofPdfsToParts(supabase, messageId, lineInserts, pdfs, pdfCache);

      await supabase.from('gmail_po_imports').upsert({
        message_id: messageId,
        thread_id: message.threadId,
        subject,
        from_email: from,
        received_at: date ? new Date(date).toISOString() : null,
        po_number: String(poNumber),
        po_id: existingPO.id,
        attachment_filename: pdfFilenames.join(', '),
        status: 'imported',
        raw_extraction: extracted,
      }, { onConflict: 'message_id' });

      // Identify unmatched parts for catalog addition
      const unmatchedParts = extractedLines
        .filter((l: any) => {
          const partNum = l.supplier_part || l.part_number;
          return !catalogItems.find((c: any) =>
            c.part_number.toUpperCase() === (partNum || '').toUpperCase() ||
            c.part_number.toUpperCase() === (l.part_number || '').toUpperCase()
          );
        })
        .map((l: any) => ({
          part_number: l.supplier_part || l.part_number,
          description: l.description || '',
          unit_price: parseFloat(l.unit_price) || 0,
        }));

      await notifyPoImported(supabase, {
        poId: existingPO.id,
        poNumber: String(poNumber),
        customer,
        lineCount: lineInserts.length,
        graphicsCount: countGraphicsLines(lineInserts),
        updated: true,
        actorId,
      });

      return NextResponse.json({
        status: 'updated',
        poNumber,
        poId: existingPO.id,
        customer,
        lineCount: lineInserts.length,
        unmatchedParts,
        extracted,
        proofsAttached,
      });
    }

    // Create new PO
    if (autoCreate !== false) {
      const catalogItems = await loadCatalogItems(supabase);

      const { customer, customerNetsuiteId } = await resolvePoCustomer(supabase, extracted.customer);

      const { data: adminUser } = await supabase
        .from('profiles')
        .select('id')
        .eq('role', 'admin')
        .limit(1)
        .single();

      const insertPayload: any = {
        po_number: String(poNumber),
        customer,
        customer_netsuite_id: customerNetsuiteId,
        ordered_date: normalizeDate(extracted.ordered_date),
        requested_delivery_date:
          normalizeDate(extracted.requested_delivery_date) ||
          earliestLineDeliveryDate(extractedLines),
        notes: extracted.notes ? String(extracted.notes) : null,
        ship_to: extracted.ship_to || null,
      };
      if (adminUser?.id) {
        insertPayload.created_by = adminUser.id;
      }

      const { data: newPO, error: poError } = await supabase
        .from('purchase_orders')
        .insert(insertPayload)
        .select()
        .single();

      if (poError || !newPO) {
        await supabase.from('gmail_po_imports').upsert({
          message_id: messageId,
          thread_id: message.threadId,
          subject,
          from_email: from,
          received_at: date ? new Date(date).toISOString() : null,
          po_number: String(poNumber),
          attachment_filename: pdfFilenames.join(', '),
          status: 'error',
          error_message: `Failed to create PO: ${poError?.message}`,
          raw_extraction: extracted,
        }, { onConflict: 'message_id' });

        return NextResponse.json({ error: 'Failed to create PO', details: poError?.message }, { status: 500 });
      }

      const lineInserts = extractedLines.map((l: any) => {
        const partNum = l.supplier_part || l.part_number;
        const catalogMatch = catalogItems.find((c: any) =>
          c.part_number.toUpperCase() === (partNum || '').toUpperCase() ||
          c.part_number.toUpperCase() === (l.part_number || '').toUpperCase()
        );
        return {
          po_id: newPO.id,
          ...(catalogMatch?.id ? { part_id: catalogMatch.id } : {}),
          part_number: partNum,
          description: l.description || null,
          quantity: parseInt(l.quantity) || 0,
          unit_price: parseFloat(l.unit_price) || 0,
        };
      });

      if (lineInserts.length > 0) {
        await supabase.from('po_line_items').insert(lineInserts);
      }

      await savePoFilesToStorage(supabase, newPO.id, messageId, poPdfs, pdfCache);
      const proofsAttached = await attachProofPdfsToParts(supabase, messageId, lineInserts, pdfs, pdfCache);

      await supabase.from('gmail_po_imports').upsert({
        message_id: messageId,
        thread_id: message.threadId,
        subject,
        from_email: from,
        received_at: date ? new Date(date).toISOString() : null,
        po_number: String(poNumber),
        po_id: newPO.id,
        attachment_filename: pdfFilenames.join(', '),
        status: 'imported',
        raw_extraction: extracted,
      }, { onConflict: 'message_id' });

      // Identify unmatched parts for catalog addition
      const unmatchedParts = extractedLines
        .filter((l: any) => {
          const partNum = l.supplier_part || l.part_number;
          return !catalogItems.find((c: any) =>
            c.part_number.toUpperCase() === (partNum || '').toUpperCase() ||
            c.part_number.toUpperCase() === (l.part_number || '').toUpperCase()
          );
        })
        .map((l: any) => ({
          part_number: l.supplier_part || l.part_number,
          description: l.description || '',
          unit_price: parseFloat(l.unit_price) || 0,
        }));

      await notifyPoImported(supabase, {
        poId: newPO.id,
        poNumber: String(poNumber),
        customer,
        lineCount: lineInserts.length,
        graphicsCount: countGraphicsLines(lineInserts),
        actorId,
      });

      return NextResponse.json({
        status: 'imported',
        poNumber,
        poId: newPO.id,
        customer,
        lineCount: lineInserts.length,
        unmatchedParts,
        extracted,
        proofsAttached,
      });
    }

    // Just return extracted data
    await supabase.from('gmail_po_imports').upsert({
      message_id: messageId,
      thread_id: message.threadId,
      subject,
      from_email: from,
      received_at: date ? new Date(date).toISOString() : null,
      po_number: String(poNumber),
      attachment_filename: pdfFilenames.join(', '),
      status: 'pending',
      raw_extraction: extracted,
    }, { onConflict: 'message_id' });

    return NextResponse.json({ status: 'extracted', poNumber, extracted });
  } catch (err: any) {
    if (err.message === 'NO_GOOGLE_TOKEN') {
      return NextResponse.json({ error: 'Gmail not connected', needsAuth: true }, { status: 401 });
    }
    console.error('Import PO error:', err);
    return NextResponse.json({ error: err.message || 'Failed to import PO' }, { status: 500 });
  }
}
