import { NextRequest, NextResponse } from 'next/server';
import { getMessage, getAttachment, getProofAttachments, proofContentType } from '@/lib/google';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { r2Upload } from '@/lib/r2';
import { validateBody, z } from '@/lib/validate';

// Downloading the attachment from Gmail + uploading to R2 can exceed Vercel's
// default ~10s ceiling for larger proofs.
export const maxDuration = 60;

const Schema = z.object({
  messageId: z.string().min(1).max(200),
  attachmentId: z.string().min(1),
  // Filename from the picker; we still re-resolve from the message as a guard.
  filename: z.string().min(1).max(300).optional(),
});

// Attach a Gmail proof attachment to a catalog part: download the chosen
// attachment, store it in the graphics-proofs bucket under the same path shape
// the manual upload uses, and record a part_files row. Mirrors the parts page's
// uploadPartFile() so the new file shows up in "Files & Proofs" identically.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { messageId, attachmentId, filename: providedName } = parsed.data;
  const partId = params.id;

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { data: part } = await supabase
      .from('netsuite_parts')
      .select('id')
      .eq('id', partId)
      .maybeSingle();
    if (!part) return NextResponse.json({ error: 'Part not found' }, { status: 404 });

    // Re-resolve the attachment from the message so the filename/mime are
    // trustworthy even if the picker passed a stale or spoofed name.
    const message = await getMessage(messageId);
    const match = getProofAttachments(message).find((a) => a.attachmentId === attachmentId);
    const filename = providedName || match?.filename || 'proof';
    const contentType = proofContentType(filename, match?.mimeType);

    const base64 = await getAttachment(messageId, attachmentId);
    const buffer = Buffer.from(base64, 'base64');

    const ext = (filename.split('.').pop() || 'bin').toLowerCase();
    const path = `part-files/${partId}/${Date.now()}.${ext}`;
    const up = await r2Upload('graphics-proofs', path, buffer, contentType);
    if (!up.success) {
      return NextResponse.json({ error: up.error || 'Upload failed' }, { status: 500 });
    }

    const { data: row, error: insErr } = await supabase
      .from('part_files')
      .insert({
        part_id: partId,
        file_name: filename,
        file_type: contentType,
        file_size: buffer.length,
        storage_path: path,
        uploaded_by: auth.user?.id || null,
      })
      .select()
      .single();

    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

    return NextResponse.json({ file: row });
  } catch (err: any) {
    if (err.message === 'NO_GOOGLE_TOKEN') {
      return NextResponse.json({ error: 'Gmail not connected', needsAuth: true }, { status: 401 });
    }
    console.error('attach-proof error:', err);
    return NextResponse.json({ error: err.message || 'Attach failed' }, { status: 500 });
  }
}
