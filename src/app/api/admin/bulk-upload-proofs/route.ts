import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import { createClient } from '@supabase/supabase-js';
import { r2Upload, r2Delete, r2PublicUrl } from '@/lib/r2';
import { requireAdmin } from '@/lib/api-auth';
import { isStagedZipPath, loadStagedZip } from '@/lib/zip-source';

interface ProofEntry {
  path: string;
  name: string;
  catalogId: string | null;  // matched catalog item
  customer: string;
  vehicleType: string;
  include: boolean;
}

/**
 * POST /api/admin/bulk-upload-proofs
 * Accepts the ZIP file again plus the reviewed manifest.
 * Uploads PDFs to Supabase storage and creates catalog_proofs records.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  try {
    // Preferred: staged-in-R2 ZIP referenced by key + JSON manifest (sent in
    // chunks by the client). Legacy multipart kept for small files.
    let manifest: ProofEntry[];
    let zipPromise: Promise<import('jszip') | null>;
    if ((req.headers.get('content-type') || '').includes('application/json')) {
      const body = await req.json();
      if (!isStagedZipPath(body?.zipPath)) {
        return NextResponse.json({ error: 'Invalid zipPath' }, { status: 400 });
      }
      if (!Array.isArray(body?.manifest)) {
        return NextResponse.json({ error: 'Manifest required' }, { status: 400 });
      }
      manifest = body.manifest;
      zipPromise = loadStagedZip(body.zipPath);
    } else {
      const formData = await req.formData();
      const zipFile = formData.get('file') as File;
      const manifestJson = formData.get('manifest') as string;
      if (!zipFile || !manifestJson) {
        return NextResponse.json({ error: 'ZIP file and manifest required' }, { status: 400 });
      }
      manifest = JSON.parse(manifestJson);
      zipPromise = zipFile.arrayBuffer().then(buf => JSZip.loadAsync(buf));
    }
    const included = manifest.filter(e => e.include && e.catalogId);

    if (included.length === 0) {
      return NextResponse.json({ error: 'No proofs selected for upload (each needs a catalog match)' }, { status: 400 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const zip = await zipPromise;
    if (!zip) return NextResponse.json({ error: 'Staged ZIP not found in storage' }, { status: 400 });

    const results: { name: string; status: 'success' | 'error'; error?: string }[] = [];

    for (const entry of included) {
      try {
        const fileEntry = zip.files[entry.path];
        if (!fileEntry) {
          results.push({ name: entry.name, status: 'error', error: 'File not found in ZIP' });
          continue;
        }

        const fileData = await fileEntry.async('uint8array');
        const slug = `${entry.customer}-${entry.name}`
          .toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/-+/g, '-').slice(0, 100);
        const storagePath = `${entry.catalogId}/${slug}`;

        // Upload to R2
        try {
          await r2Upload('proofs', storagePath, Buffer.from(fileData), 'application/pdf');
        } catch (uploadErr: any) {
          results.push({ name: entry.name, status: 'error', error: uploadErr.message });
          continue;
        }

        // Get existing proof count for sort order
        const { count } = await supabase
          .from('catalog_proofs')
          .select('*', { count: 'exact', head: true })
          .eq('catalog_id', entry.catalogId!);

        // Create catalog_proofs record
        const { error: insertError } = await supabase.from('catalog_proofs').insert({
          catalog_id: entry.catalogId,
          file_path: storagePath,
          file_name: entry.name,
          file_type: 'application/pdf',
          sort_order: (count || 0) + 1,
          label: entry.vehicleType || null,
        });

        if (insertError) {
          results.push({ name: entry.name, status: 'error', error: insertError.message });
        } else {
          results.push({ name: entry.name, status: 'success' });
        }
      } catch (e: any) {
        results.push({ name: entry.name, status: 'error', error: e.message });
      }
    }

    const successCount = results.filter(r => r.status === 'success').length;
    const errorCount = results.filter(r => r.status === 'error').length;

    return NextResponse.json({
      message: `Uploaded ${successCount} proof${successCount !== 1 ? 's' : ''}${errorCount > 0 ? `, ${errorCount} error${errorCount !== 1 ? 's' : ''}` : ''}`,
      results,
      summary: { total: included.length, success: successCount, errors: errorCount },
    });
  } catch (err: any) {
    console.error('Bulk proof upload error:', err);
    return NextResponse.json({ error: err.message || 'Failed to upload proofs' }, { status: 500 });
  }
}
