import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';

/**
 * POST /api/admin/upload-zip
 * Accepts a ZIP file, extracts it, and returns a manifest of files
 * with folder-structure-based metadata (make/model/year for templates,
 * customer/vehicle-type for proofs).
 *
 * Query params:
 *   type=templates | proofs
 *
 * For type=templates: expects folder structure like Make/Category/Model/Year/files
 * For type=proofs: expects folder structure like Customer/VehicleType/files
 *
 * Returns: { files: [{ path, name, ext, size, folderParts, suggested }] }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  try {
    const url = new URL(req.url);
    const type = url.searchParams.get('type') || 'templates';

    const formData = await req.formData();
    const zipFile = formData.get('file') as File;

    if (!zipFile) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    const arrayBuffer = await zipFile.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);

    const files: {
      path: string;
      name: string;
      ext: string;
      size: number;
      folderParts: string[];
      suggested: Record<string, string>;
      hasThumbnail?: boolean;
      thumbnailPath?: string;
    }[] = [];

    // Collect all file paths first to find EPS/JPG pairs
    const allPaths: string[] = [];
    zip.forEach((relativePath) => {
      allPaths.push(relativePath);
    });

    for (const [relativePath, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;

      // Skip __MACOSX and hidden files
      if (relativePath.startsWith('__MACOSX') || relativePath.includes('/._') || relativePath.startsWith('.')) continue;

      const parts = relativePath.split('/').filter(Boolean);
      const fileName = parts[parts.length - 1];
      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      const folderParts = parts.slice(0, -1);

      // For templates, skip JPG/PNG thumbnails — they'll be matched to EPS files
      if (type === 'templates' && (ext === 'jpg' || ext === 'jpeg' || ext === 'png')) {
        continue; // We'll attach these as thumbnails to EPS entries
      }

      // For proofs, only include PDFs
      if (type === 'proofs' && ext !== 'pdf') {
        continue;
      }

      const fileData = await entry.async('uint8array');
      const suggested: Record<string, string> = {};

      if (type === 'templates') {
        // Folder structure: Make/Category/Model/Year or Make/Model/Year
        // Try to be flexible with varying depth
        if (folderParts.length >= 4) {
          suggested.make = folderParts[0];
          // folderParts[1] might be "Vans", "Trucks", etc. — use as category hint
          suggested.model = folderParts[2];
          suggested.year = folderParts[3];
        } else if (folderParts.length >= 3) {
          suggested.make = folderParts[0];
          suggested.model = folderParts[1];
          suggested.year = folderParts[2];
        } else if (folderParts.length >= 2) {
          suggested.make = folderParts[0];
          suggested.model = folderParts[1];
        } else if (folderParts.length >= 1) {
          suggested.make = folderParts[0];
        }

        // Generate a name from the filename without extension
        const baseName = fileName.replace(/\.[^/.]+$/, '');
        suggested.name = `${suggested.make || ''} ${suggested.model || ''} ${suggested.year || ''} ${baseName}`.trim();

        // Check for matching JPG/PNG thumbnail
        const baseWithoutExt = relativePath.replace(/\.[^/.]+$/, '');
        const possibleThumbs = [
          baseWithoutExt + '.jpg',
          baseWithoutExt + '.jpeg',
          baseWithoutExt + '.png',
          baseWithoutExt + '.JPG',
          baseWithoutExt + '.JPEG',
          baseWithoutExt + '.PNG',
        ];
        const thumbPath = possibleThumbs.find(p => zip.files[p]);

        files.push({
          path: relativePath,
          name: fileName,
          ext,
          size: fileData.length,
          folderParts,
          suggested,
          hasThumbnail: !!thumbPath,
          thumbnailPath: thumbPath || undefined,
        });
      } else {
        // Proofs — folder structure: Customer/VehicleType/files
        if (folderParts.length >= 2) {
          suggested.customer = folderParts[0];
          suggested.vehicle_type = folderParts[1];
        } else if (folderParts.length >= 1) {
          suggested.customer = folderParts[0];
        }
        suggested.filename = fileName;

        files.push({
          path: relativePath,
          name: fileName,
          ext,
          size: fileData.length,
          folderParts,
          suggested,
        });
      }
    }

    return NextResponse.json({
      type,
      totalFiles: files.length,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
    });
  } catch (err: any) {
    console.error('ZIP extract error:', err);
    return NextResponse.json({ error: err.message || 'Failed to process ZIP file' }, { status: 500 });
  }
}

// App Router route handlers don't need bodyParser config.
// Body size limits are controlled by next.config.js and the hosting platform.
