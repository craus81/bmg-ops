import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import { createClient } from '@supabase/supabase-js';

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
  try {
    const formData = await req.formData();
    const zipFile = formData.get('file') as File;
    const manifestJson = formData.get('manifest') as string;

    if (!zipFile || !manifestJson) {
      return NextResponse.json({ error: 'ZIP file and manifest required' }, { status: 400 });
    }

    const manifest: ProofEntry[] = JSON.parse(manifestJson);
    const included = manifest.filter(e => e.include && e.catalogId);

    if (included.length === 0) {
      return NextResponse.json({ error: 'No proofs selected for upload (each needs a catalog match)' }, { status: 400 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const arrayBuffer = await zipFile.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);

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

        // Upload to Supabase storage
        const { error: uploadError } = await supabase.storage
          .from('proofs')
          .upload(storagePath, fileData, { contentType: 'application/pdf', upsert: true });

        if (uploadError) {
          results.push({ name: entry.name, status: 'error', error: uploadError.message });
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
