import { NextRequest, NextResponse } from 'next/server';
import { downloadFile } from '@/lib/dropbox';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { r2Upload } from '@/lib/r2';
import { validateBody, z } from '@/lib/validate';

// Downloading from Dropbox + uploading to R2 can exceed Vercel's default ~10s
// ceiling for larger proofs.
export const maxDuration = 60;

const Schema = z.object({
  dropboxPath: z.string().trim().min(1).max(2000),
  // Display name from the picker; we fall back to Dropbox's own filename.
  filename: z.string().min(1).max(300).optional(),
});

// Attach a Dropbox proof file to a catalog part: download the chosen file,
// store it in the graphics-proofs bucket under the same path shape the manual
// upload uses, and record a part_files row. Mirrors attach-proof (email) so
// both proof sources land in "Files & Proofs" identically. Admin-gated.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { dropboxPath, filename: providedName } = parsed.data;
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

    const { buffer, name, contentType } = await downloadFile(dropboxPath);
    const filename = providedName || name || 'proof';

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
    console.error('attach-dropbox-proof error:', err);
    return NextResponse.json({ error: err.message || 'Attach failed' }, { status: 500 });
  }
}
