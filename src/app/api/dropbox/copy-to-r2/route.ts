import { NextRequest, NextResponse } from 'next/server';
import { downloadFile } from '@/lib/dropbox';
import { r2Upload } from '@/lib/r2';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Download a file from Dropbox and upload it to R2, then link it to a vehicle.
 * POST /api/dropbox/copy-to-r2
 * Body: { dropbox_path, vehicle_id, customer_name }
 */
export async function POST(req: NextRequest) {
  try {
    const { dropbox_path, vehicle_id, customer_name } = await req.json();

    if (!dropbox_path || !vehicle_id) {
      return NextResponse.json({ error: 'dropbox_path and vehicle_id are required' }, { status: 400 });
    }

    // Download from Dropbox
    const { buffer, name, contentType } = await downloadFile(dropbox_path);

    // Upload to R2 under proofs/<vehicle_id>/<filename>
    const r2Path = `${vehicle_id}/${name}`;
    const upload = await r2Upload('proofs', r2Path, buffer, contentType);

    if (!upload.success) {
      return NextResponse.json({ error: `R2 upload failed: ${upload.error}` }, { status: 500 });
    }

    // Update the vehicle record with the proof URL and dropbox source path
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { error: dbError } = await supabase
      .from('fleet_checkins')
      .update({
        proof_url: upload.publicUrl,
        proof_storage_key: upload.key,
        proof_dropbox_path: dropbox_path,
        proof_filename: name,
        proof_linked_at: new Date().toISOString(),
      })
      .eq('id', vehicle_id);

    if (dbError) {
      console.error('DB update error:', dbError);
      // File is in R2 even if DB update fails — not critical
    }

    return NextResponse.json({
      success: true,
      filename: name,
      publicUrl: upload.publicUrl,
      r2Key: upload.key,
      size: buffer.length,
    });
  } catch (err: any) {
    console.error('Dropbox copy-to-r2 error:', err);
    return NextResponse.json({ error: err.message || 'Copy failed' }, { status: 500 });
  }
}
