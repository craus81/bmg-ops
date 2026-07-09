import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import { createClient } from '@supabase/supabase-js';
import { r2Upload, r2Delete, r2PublicUrl } from '@/lib/r2';
import { requireAdmin } from '@/lib/api-auth';
import { computeCalibration, parseScaleFactor } from '@/lib/template-calibration';

interface TemplateEntry {
  path: string;
  thumbnailPath?: string;
  name: string;
  make: string;
  model: string;
  year: string;
  variant: string;
  wheelbase: string;
  doors: string;
  roofHeight: string;
  windows: string;
  include: boolean;
}

/**
 * POST /api/admin/bulk-upload-templates
 * Accepts the ZIP file again plus the reviewed manifest.
 * Uploads EPS files + thumbnails to Supabase storage and creates vehicle_templates records.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  try {
    const formData = await req.formData();
    const zipFile = formData.get('file') as File;
    const manifestJson = formData.get('manifest') as string;

    if (!zipFile || !manifestJson) {
      return NextResponse.json({ error: 'ZIP file and manifest required' }, { status: 400 });
    }

    const manifest: TemplateEntry[] = JSON.parse(manifestJson);
    const included = manifest.filter(e => e.include);

    if (included.length === 0) {
      return NextResponse.json({ error: 'No templates selected for upload' }, { status: 400 });
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
        const slug = `${entry.make}-${entry.model}-${entry.year}-${entry.name}`
          .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').slice(0, 80);

        let originalFilePath: string | null = null;
        let templateImagePath: string | null = null;
        let epsData: Uint8Array | null = null;
        let thumbData: Uint8Array | null = null;

        // Upload the EPS/original file
        const epsEntry = zip.files[entry.path];
        if (epsEntry) {
          try {
            epsData = await epsEntry.async('uint8array');
            const ext = entry.path.split('.').pop()?.toLowerCase() || 'eps';
            const storagePath = `originals/${entry.make}/${entry.model}/${entry.year}/${slug}.${ext}`;
            await r2Upload('vehicle-templates', storagePath, Buffer.from(epsData), 'application/postscript');
            originalFilePath = storagePath;
          } catch (err: any) {
            console.error('EPS upload error:', err);
          }
        }

        // Upload the thumbnail if it exists
        if (entry.thumbnailPath) {
          const thumbEntry = zip.files[entry.thumbnailPath];
          if (thumbEntry) {
            try {
              thumbData = await thumbEntry.async('uint8array');
              const thumbExt = entry.thumbnailPath.split('.').pop()?.toLowerCase() || 'jpg';
              const contentType = thumbExt === 'png' ? 'image/png' : 'image/jpeg';
              const thumbStoragePath = `previews/${entry.make}/${entry.model}/${entry.year}/${slug}.${thumbExt}`;
              await r2Upload('vehicle-templates', thumbStoragePath, Buffer.from(thumbData), contentType);
              templateImagePath = thumbStoragePath;
            } catch (err: any) {
              console.error('Thumbnail upload error:', err);
            }
          }
        }

        // Auto-calibrate the wrap estimator scale from the vector artboard
        // (EPS BoundingBox / AI MediaBox) and the preview's pixel size —
        // templates are drawn 1:20. Null when the pair can't be trusted
        // (e.g. cropped preview); those fall back to manual calibration.
        const pxPerIn = epsData && thumbData
          ? computeCalibration(epsData, thumbData, parseScaleFactor('1:20')).pxPerIn
          : null;

        // Insert the template record
        const { error: insertError } = await supabase.from('vehicle_templates').insert({
          name: entry.name,
          make: entry.make,
          model: entry.model,
          year: entry.year || null,
          variant: entry.variant || null,
          wheelbase_in: entry.wheelbase ? parseFloat(entry.wheelbase) : null,
          doors: entry.doors || null,
          roof_height: entry.roofHeight || null,
          windows: entry.windows || null,
          template_image_path: templateImagePath,
          original_file_path: originalFilePath,
          px_per_in: pxPerIn,
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
      message: `Uploaded ${successCount} template${successCount !== 1 ? 's' : ''}${errorCount > 0 ? `, ${errorCount} error${errorCount !== 1 ? 's' : ''}` : ''}`,
      results,
      summary: { total: included.length, success: successCount, errors: errorCount },
    });
  } catch (err: any) {
    console.error('Bulk upload error:', err);
    return NextResponse.json({ error: err.message || 'Failed to upload templates' }, { status: 500 });
  }
}
