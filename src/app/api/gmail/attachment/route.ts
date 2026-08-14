import { NextRequest, NextResponse } from 'next/server';
import { getAttachment, getMessage, getPdfAttachments, getProofAttachments, proofContentType } from '@/lib/google';
import { requireStaff } from '@/lib/api-auth';
import { isProofLikeName } from '@/lib/pdf-classify';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Stream a single Gmail attachment's bytes so the proof picker can preview it
// before it's attached. Loaded via <img> / pdfjs (same-origin), which can't set
// a bearer header, so this relies on cookie auth like /api/dropbox/thumbnail.
//
// attachmentId is optional: callers that only know the message (e.g. the PO
// import review panel, which stores just message_id + filename in
// gmail_po_imports) can pass messageId alone and we resolve the PDF here —
// matching on filename when given, otherwise preferring PO-looking names then
// the largest file, mirroring the sort in /api/gmail/import-po.
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const messageId = req.nextUrl.searchParams.get('messageId');
  let attachmentId = req.nextUrl.searchParams.get('attachmentId');
  let filename = req.nextUrl.searchParams.get('filename') || 'proof';
  if (!messageId) {
    return NextResponse.json({ error: 'messageId is required' }, { status: 400 });
  }

  try {
    if (!attachmentId) {
      const message = await getMessage(messageId);
      const requested = req.nextUrl.searchParams.get('filename');
      // Exact-name match across every proof-type attachment (images and design
      // files, not just PDFs) — the proof-sweep review queue stores only
      // message_id + filename, and its rows are often PNGs/JPGs. Same resolver
      // the queue's attach action uses, so preview and attach agree.
      const proofMatch = requested ? getProofAttachments(message).find(a => a.filename === requested) : null;
      if (proofMatch) {
        attachmentId = proofMatch.attachmentId;
        filename = proofMatch.filename;
      } else {
        const pdfs = getPdfAttachments(message);
        if (pdfs.length === 0) {
          return NextResponse.json({ error: 'No PDF attachments on this message' }, { status: 404 });
        }
        // Never fall back to a proof/artwork file while a real document exists —
        // proofs are usually the biggest attachment and would win the size sort.
        const nonProof = pdfs.filter(p => !isProofLikeName(p.filename));
        const pool = nonProof.length > 0 ? nonProof : pdfs;
        const best = [...pool].sort((a, b) => {
          const aIsPO = /\b(po|purchase.?order)\b/i.test(a.filename) ? 1 : 0;
          const bIsPO = /\b(po|purchase.?order)\b/i.test(b.filename) ? 1 : 0;
          if (aIsPO !== bIsPO) return bIsPO - aIsPO;
          return b.size - a.size;
        })[0];
        attachmentId = best.attachmentId;
        filename = best.filename;
      }
    }

    const base64 = await getAttachment(messageId, attachmentId);
    const buffer = Buffer.from(base64, 'base64');
    const contentType = proofContentType(filename);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': contentType,
        // Private: this is a single user's mail. Short cache so re-renders in
        // the picker don't re-download the same attachment.
        'Cache-Control': 'private, max-age=3600',
        // These bytes come from external email: nosniff stops HTML disguised
        // under an image/pdf type from rendering, and SVG (the one proof type
        // whose scripts would run on our origin when opened directly) gets
        // sandboxed — <img> consumers never execute SVG scripts, so thumbnails
        // are unaffected. Broader types (pdf/png/jpg) stay unsandboxed so the
        // browser's inline PDF viewer keeps working.
        'X-Content-Type-Options': 'nosniff',
        ...(contentType === 'image/svg+xml' ? { 'Content-Security-Policy': 'sandbox' } : {}),
      },
    });
  } catch (err: any) {
    if (err.message === 'NO_GOOGLE_TOKEN') {
      return NextResponse.json({ error: 'Gmail not connected' }, { status: 401 });
    }
    console.error('gmail attachment error:', err);
    return NextResponse.json({ error: err.message || 'Failed to load attachment' }, { status: 500 });
  }
}
