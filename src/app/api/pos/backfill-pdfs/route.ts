import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { getGmailClient, getMessage, getHeader, getPdfAttachments, getAttachment } from '@/lib/google';
import { r2Upload } from '@/lib/r2';
import { isProofLikeName } from '@/lib/pdf-classify';

export const dynamic = 'force-dynamic';
// Gmail lookups + PDF downloads + R2 uploads for a batch of POs runs well
// past the default ceiling.
export const maxDuration = 60;

const Schema = z.object({
  // POs already found unmatched in a previous batch — skipped this run so
  // repeated clicks make progress instead of rescanning the same misses.
  skipPoIds: z.array(z.string().uuid()).max(2000).optional(),
});

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Stop starting new POs when this much of the function budget is spent, so
// the batch in flight can finish and return a real report instead of a 504.
// Kept well under maxDuration: a single PO can burn 10s+ on Gmail searches
// and large downloads, and a batch that dies at the ceiling reports nothing.
const TIME_BUDGET_MS = 35_000;


/**
 * POST /api/pos/backfill-pdfs — find the source PDF for POs that have no
 * stored PDF and attach it.
 *
 * Two lookup passes per PO:
 *  1. gmail_po_imports — POs that came in through the email importer already
 *     have their message recorded, so the PDF is one download away.
 *  2. Gmail search on the PO number (has:attachment filename:pdf). A match is
 *     only accepted when the PO number appears in the subject or an
 *     attachment filename — body-text hits alone are too loose to trust.
 *
 * PDFs from the matched email are stored exactly like the importer does
 * (R2 graphics-proofs bucket + po_files row); proof/artwork files are left
 * out unless their filename carries the PO number. Runs in time-budgeted
 * batches — call again with the returned noMatch ids in skipPoIds until
 * remaining is 0.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const skip = new Set(parsed.data.skipPoIds || []);

  const startedAt = Date.now();

  try {
    // Cheap location pass FIRST: many POs imported before ship_to persistence
    // existed already have the address sitting in their gmail import record's
    // extraction — a DB read, no AI. Sub-budgeted so the PDF pass still runs.
    let locationsFromRecords = 0;
    {
      const LOC_PASS_BUDGET_MS = 15_000;
      const { data: noLoc } = await service
        .from('purchase_orders')
        .select('id, po_number')
        .is('ship_to', null);
      for (const po of noLoc || []) {
        if (Date.now() - startedAt > LOC_PASS_BUDGET_MS) break;
        const poNumber = String(po.po_number || '').trim();
        if (!poNumber) continue;
        try {
          const { data: imports } = await service
            .from('gmail_po_imports')
            .select('po_id, po_number, raw_extraction')
            .or(`po_id.eq.${po.id},po_number.ilike.%${poNumber}%`)
            .limit(5);
          let shipTo: any = null;
          for (const rec of imports || []) {
            const raw: any = rec.raw_extraction;
            if (!raw) continue;
            if (raw.multi && Array.isArray(raw.pos)) {
              const entry = raw.pos.find((p: any) => String((p?.extracted || p)?.po_number || '') === poNumber);
              shipTo = (entry?.extracted || entry)?.ship_to || null;
            } else if (
              rec.po_id === po.id ||
              String(rec.po_number || '').split(',').map(s => s.trim()).includes(poNumber)
            ) {
              shipTo = raw.ship_to || null;
            }
            if (shipTo) break;
          }
          if (shipTo && typeof shipTo === 'object' && (shipTo.name || shipTo.city)) {
            await service.from('purchase_orders').update({ ship_to: shipTo }).eq('id', po.id);
            locationsFromRecords++;
          }
        } catch { /* best-effort per PO */ }
      }
    }
    // POs with no stored PDF, newest first (recent POs are the ones people
    // actually open).
    const { data: allPos, error: posErr } = await service
      .from('purchase_orders')
      .select('id, po_number, po_files(id)')
      .order('created_at', { ascending: false });
    if (posErr) {
      return NextResponse.json({ error: 'Failed to load POs: ' + posErr.message }, { status: 500 });
    }
    const missing = (allPos || []).filter(p => (p.po_files || []).length === 0);
    const queue = missing.filter(p => !skip.has(p.id));

    const attached: { poId: string; poNumber: string; files: number }[] = [];
    const noMatch: { poId: string; poNumber: string }[] = [];
    // POs whose email WAS found but whose files couldn't be stored (R2 or
    // po_files insert failure). Reported separately, and skipped on follow-up
    // batches like noMatch — otherwise a persistent storage failure makes the
    // client loop re-process the same POs forever.
    const storeFailed: { poId: string; poNumber: string }[] = [];
    let processed = 0;

    for (const po of queue) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break;
      processed++;
      const poNumber = String(po.po_number || '').trim();
      if (!poNumber) {
        noMatch.push({ poId: po.id, poNumber });
        continue;
      }

      try {
        // Pass 1: the importer's own record of which email carried this PO.
        let messageId: string | null = null;
        const { data: imports } = await service
          .from('gmail_po_imports')
          .select('message_id, po_id, po_number')
          .or(`po_id.eq.${po.id},po_number.ilike.%${poNumber}%`)
          .limit(5);
        // po_number can be a comma-joined list (multi-PO emails) — require a
        // whole-token match, not just the ilike substring hit.
        const hit = (imports || []).find(r =>
          r.po_id === po.id ||
          String(r.po_number || '').split(',').map(s => s.trim()).includes(poNumber),
        );
        if (hit) messageId = hit.message_id;

        // Pass 2: search the inbox for the PO number.
        if (!messageId) {
          const gmail = await getGmailClient();
          const list = await gmail.users.messages.list({
            userId: 'me',
            q: `"${poNumber}" has:attachment filename:pdf`,
            maxResults: 3,
          });
          for (const m of list.data.messages || []) {
            const full = await getMessage(m.id!);
            const subject = getHeader(full, 'Subject') || '';
            const pdfs = getPdfAttachments(full);
            if (subject.includes(poNumber) || pdfs.some(p => p.filename.includes(poNumber))) {
              messageId = m.id!;
              break;
            }
          }
        }

        if (!messageId) {
          noMatch.push({ poId: po.id, poNumber });
          continue;
        }

        const message = await getMessage(messageId);
        const pdfs = getPdfAttachments(message).filter(
          p => !isProofLikeName(p.filename) || p.filename.includes(poNumber),
        );
        if (pdfs.length === 0) {
          noMatch.push({ poId: po.id, poNumber });
          continue;
        }

        let files = 0;
        let storeError = false;
        for (const pdf of pdfs) {
          const base64 = await getAttachment(messageId, pdf.attachmentId);
          const buffer = Buffer.from(base64, 'base64');
          const safeName = pdf.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
          const path = `po-pdfs/${po.id}/${Date.now()}-${safeName}`;
          const up = await r2Upload('graphics-proofs', path, buffer, 'application/pdf');
          if (!up.success) {
            console.warn('Backfill R2 upload failed:', pdf.filename, up.error);
            storeError = true;
            continue;
          }
          // A failed insert means the PO still has no po_files row — it MUST
          // NOT count as attached, or the PO stays in `missing` and every
          // subsequent batch re-attaches it forever (the 2812-attached run:
          // migration 097's source CHECK rejected 'email_backfill' — allowed
          // as of migration 138 — and the error went unchecked).
          const { error: insErr } = await service.from('po_files').insert({
            po_id: po.id,
            file_name: pdf.filename,
            file_type: 'application/pdf',
            file_size: buffer.length,
            storage_path: path,
            source: 'email_backfill',
          });
          if (insErr) {
            console.warn(`Backfill po_files insert failed for PO ${poNumber}:`, insErr.message);
            storeError = true;
            continue;
          }
          files++;
        }

        if (files > 0) attached.push({ poId: po.id, poNumber, files });
        else if (storeError) storeFailed.push({ poId: po.id, poNumber });
        else noMatch.push({ poId: po.id, poNumber });
      } catch (err: any) {
        if (err?.message === 'NO_GOOGLE_TOKEN') throw err;
        console.warn(`Backfill failed for PO ${poNumber}:`, err);
        noMatch.push({ poId: po.id, poNumber });
      }
    }

    return NextResponse.json({
      success: true,
      missingTotal: missing.length,
      processed,
      attached,
      noMatch,
      storeFailed,
      locationsFromRecords,
      // POs still untouched this run (time budget) — another call continues.
      remaining: queue.length - processed,
    });
  } catch (err: any) {
    if (err.message === 'NO_GOOGLE_TOKEN') {
      return NextResponse.json({ error: 'Gmail not connected', needsAuth: true }, { status: 401 });
    }
    console.error('PO PDF backfill error:', err);
    return NextResponse.json({ error: err.message || 'Backfill failed' }, { status: 500 });
  }
}
