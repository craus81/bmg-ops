import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { r2Upload } from '@/lib/r2';
import { fetchAllRows } from '@/lib/fetch-all';
import {
  getGmailClient, getMessage, getAttachment, getProofAttachments,
  proofContentType, getHeader,
} from '@/lib/google';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * K12 proof sweep: bulk "search email for proofs and part numbers and
 * attach them to part records." Per part: one Gmail search, then each
 * proof attachment is classified —
 *   HIGH (auto-attach): part number in the attachment FILENAME, or in the
 *     subject of a message with exactly one proof attachment
 *   REVIEW (queued): the message matched the part-number search but the
 *     attachment itself doesn't carry the number
 * Nothing below that bar ever attaches — a wrong proof on a part is worse
 * than none, because installers see these in the scanner.
 *
 * The queue table doubles as the sweep's memory: (part, message, filename)
 * rows in any status are skipped on re-runs, and existing part_files with
 * the same name are never re-attached, so the sweep is idempotent.
 */

const Schema = z.discriminatedUnion('mode', [
  // Resolve the default scope: distinct part numbers on OPEN POs, matched
  // to active catalog parts — or an explicitly pasted part-number list.
  z.object({
    mode: z.literal('scope'),
    partNumbers: z.array(z.string().trim().min(1).max(80)).max(500).optional(),
  }),
  // Sweep a small batch of parts (the client loops with progress).
  z.object({
    mode: z.literal('run'),
    parts: z.array(z.object({ partId: z.string().uuid(), partNumber: z.string().trim().min(1).max(80) })).min(1).max(6),
    days: z.number().int().min(7).max(1825).optional(),
  }),
  // Resolve one review-queue row.
  z.object({
    mode: z.literal('resolve'),
    queueId: z.string().uuid(),
    action: z.enum(['attach', 'dismiss']),
  }),
]);

// Fewer messages per part than the interactive search — the sweep multiplies
// by parts, and the most recent proof mentions are what matter.
const MAX_MESSAGES_PER_PART = 15;
// A 40-attachment vendor thread shouldn't dump its whole payload on one
// part unattended; overflow goes to review instead.
const MAX_AUTO_ATTACH_PER_PART = 4;

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

async function attachToPart(
  partId: string, messageId: string, filename: string,
  attachmentId: string, mimeType: string | undefined, actorId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const contentType = proofContentType(filename, mimeType);
  const base64 = await getAttachment(messageId, attachmentId);
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) return { ok: false, error: 'Empty attachment' };
  const ext = (filename.split('.').pop() || 'bin').toLowerCase();
  const path = `part-files/${partId}/${Date.now()}.${ext}`;
  const up = await r2Upload('graphics-proofs', path, buffer, contentType);
  if (!up.success) return { ok: false, error: up.error || 'Upload failed' };
  const { error } = await supabase.from('part_files').insert({
    part_id: partId,
    file_name: filename,
    file_type: contentType,
    file_size: buffer.length,
    storage_path: path,
    uploaded_by: actorId,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** GET: the pending review queue (newest first), with part numbers. */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const { data, error } = await supabase
    .from('proof_sweep_queue')
    .select('id, part_id, part_number, message_id, filename, mime_type, size_bytes, subject, from_addr, email_date, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ queue: data || [] });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  try {
    if (body.mode === 'scope') {
      // Active catalog parts keyed by normalized number.
      const { data: parts, error } = await fetchAllRows<any>((from, to) => supabase
        .from('netsuite_parts')
        .select('id, item_number')
        .eq('is_active', true)
        .not('item_number', 'is', null)
        .order('id')
        .range(from, to));
      if (error) throw new Error('Parts read failed: ' + error.message);
      const byNorm = new Map<string, { id: string; item_number: string }>();
      for (const p of parts || []) {
        const key = norm(p.item_number);
        if (key && !byNorm.has(key)) byNorm.set(key, p);
      }

      let wanted: string[];
      if (body.partNumbers && body.partNumbers.length > 0) {
        wanted = body.partNumbers;
      } else {
        // Ashley's seed: part numbers still open on POs.
        const { data: openPos } = await fetchAllRows<any>((from, to) => supabase
          .from('purchase_orders')
          .select('id')
          .eq('status', 'open')
          .order('id')
          .range(from, to));
        const openIds = (openPos || []).map((p: any) => p.id);
        const numbers = new Set<string>();
        for (let i = 0; i < openIds.length; i += 100) {
          const { data: lines } = await supabase
            .from('po_line_items')
            .select('part_number')
            .in('po_id', openIds.slice(i, i + 100));
          for (const l of lines || []) if (l.part_number) numbers.add(String(l.part_number));
        }
        wanted = [...numbers];
      }

      const matched: { partId: string; partNumber: string }[] = [];
      const unmatched: string[] = [];
      for (const n of wanted) {
        const hit = byNorm.get(norm(n));
        if (hit) matched.push({ partId: hit.id, partNumber: hit.item_number });
        else unmatched.push(n);
      }
      matched.sort((a, b) => a.partNumber.localeCompare(b.partNumber));
      return NextResponse.json({ parts: matched, unmatched: unmatched.slice(0, 50), unmatchedTotal: unmatched.length });
    }

    if (body.mode === 'run') {
      await getGmailClient(); // fail fast with needsAuth before doing any work
      const days = body.days || 365;
      const after = new Date();
      after.setDate(after.getDate() - days);
      const afterStr = `${after.getFullYear()}/${after.getMonth() + 1}/${after.getDate()}`;
      const gmail = await getGmailClient();

      const results: { partNumber: string; attached: number; queued: number; skipped: number; error?: string }[] = [];

      for (const part of body.parts) {
        const r = { partNumber: part.partNumber, attached: 0, queued: 0, skipped: 0 } as (typeof results)[number];
        try {
          // What this part already has / already saw — the idempotency set.
          const [{ data: existingFiles }, { data: seenRows }] = await Promise.all([
            supabase.from('part_files').select('file_name').eq('part_id', part.partId),
            supabase.from('proof_sweep_queue').select('message_id, filename').eq('part_id', part.partId),
          ]);
          const haveNames = new Set((existingFiles || []).map((f: any) => norm(f.file_name)));
          const seen = new Set((seenRows || []).map((s: any) => `${s.message_id}:${s.filename}`));

          const list = await gmail.users.messages.list({
            userId: 'me',
            q: `has:attachment ("${part.partNumber.replace(/"/g, '')}") after:${afterStr}`,
            maxResults: MAX_MESSAGES_PER_PART,
          });
          const partNorm = norm(part.partNumber);

          for (const m of list.data.messages || []) {
            const full = await getMessage(m.id!);
            const atts = getProofAttachments(full);
            if (atts.length === 0) continue;
            const subject = getHeader(full, 'Subject') || '(no subject)';
            const from = getHeader(full, 'From') || '';
            const date = getHeader(full, 'Date') || '';
            const subjectHasPart = norm(subject).includes(partNorm);

            for (const a of atts) {
              const dedupeKey = `${m.id}:${a.filename}`;
              if (seen.has(dedupeKey) || haveNames.has(norm(a.filename))) { r.skipped++; continue; }
              seen.add(dedupeKey);

              const filenameHasPart = norm(a.filename).includes(partNorm);
              const high = filenameHasPart || (subjectHasPart && atts.length === 1);
              const canAuto = high && r.attached < MAX_AUTO_ATTACH_PER_PART;

              const row = {
                part_id: part.partId,
                part_number: part.partNumber,
                message_id: m.id!,
                filename: a.filename,
                mime_type: a.mimeType || null,
                size_bytes: a.size || null,
                subject, from_addr: from, email_date: date,
                confidence: high ? 'high' : 'review',
              };

              if (canAuto) {
                const attach = await attachToPart(part.partId, m.id!, a.filename, a.attachmentId, a.mimeType, auth.user?.id || null);
                await supabase.from('proof_sweep_queue').upsert({
                  ...row,
                  status: attach.ok ? 'attached' : 'failed',
                  status_note: attach.ok ? 'auto-attached by sweep' : attach.error,
                  resolved_at: new Date().toISOString(),
                  resolved_by: auth.user?.id || null,
                }, { onConflict: 'part_id,message_id,filename', ignoreDuplicates: true });
                if (attach.ok) { haveNames.add(norm(a.filename)); r.attached++; } else r.queued++;
              } else {
                await supabase.from('proof_sweep_queue').upsert(
                  { ...row, status: 'pending' },
                  { onConflict: 'part_id,message_id,filename', ignoreDuplicates: true },
                );
                r.queued++;
              }
            }
          }
        } catch (err: any) {
          if (err.message === 'NO_GOOGLE_TOKEN') throw err;
          r.error = err?.message || 'sweep failed';
        }
        results.push(r);
      }
      return NextResponse.json({ results });
    }

    // mode === 'resolve'
    const { data: q } = await supabase
      .from('proof_sweep_queue')
      .select('*')
      .eq('id', body.queueId)
      .eq('status', 'pending')
      .maybeSingle();
    if (!q) return NextResponse.json({ error: 'Queue row not found (already resolved?)' }, { status: 404 });

    if (body.action === 'dismiss') {
      await supabase.from('proof_sweep_queue')
        .update({ status: 'dismissed', resolved_at: new Date().toISOString(), resolved_by: auth.user?.id || null })
        .eq('id', body.queueId);
      return NextResponse.json({ ok: true });
    }

    // attach: Gmail attachment ids are not stable across fetches — re-resolve
    // by filename from a fresh message read.
    const message = await getMessage(q.message_id);
    const match = getProofAttachments(message).find(a => a.filename === q.filename);
    if (!match) {
      await supabase.from('proof_sweep_queue')
        .update({ status: 'failed', status_note: 'Attachment no longer found on message', resolved_at: new Date().toISOString(), resolved_by: auth.user?.id || null })
        .eq('id', body.queueId);
      return NextResponse.json({ error: 'Attachment no longer found on that email' }, { status: 410 });
    }
    const attach = await attachToPart(q.part_id, q.message_id, q.filename, match.attachmentId, match.mimeType, auth.user?.id || null);
    await supabase.from('proof_sweep_queue')
      .update({
        status: attach.ok ? 'attached' : 'failed',
        status_note: attach.ok ? 'approved from review queue' : attach.error,
        resolved_at: new Date().toISOString(),
        resolved_by: auth.user?.id || null,
      })
      .eq('id', body.queueId);
    if (!attach.ok) return NextResponse.json({ error: attach.error }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    if (err.message === 'NO_GOOGLE_TOKEN') {
      return NextResponse.json({ error: 'Gmail not connected', needsAuth: true }, { status: 401 });
    }
    console.error('proof-sweep error:', err);
    return NextResponse.json({ error: err?.message || 'Proof sweep failed' }, { status: 500 });
  }
}
