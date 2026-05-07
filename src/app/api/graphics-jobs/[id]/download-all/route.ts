import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import JSZip from 'jszip';
import { requireAuth } from '@/lib/api-auth';
import { r2Get } from '@/lib/r2';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const FILE_BUCKET_PREFIX = 'graphics-proofs';

/**
 * GET /api/graphics-jobs/[id]/download-all
 *
 * Streams a ZIP of every graphics_job_files row attached to the job so
 * designers can grab the whole bundle in one click instead of opening
 * each file individually. File names inside the archive use each row's
 * original file_name (with collision suffixing). The archive itself is
 * named after the job's number/title.
 */

function sanitize(name: string, fallback = 'file'): string {
  const cleaned = (name || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
}

async function readAll(stream: any): Promise<Buffer> {
  // r2Get returns a Node.js Readable stream from @aws-sdk/client-s3.
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const { data: job } = await supabase
    .from('graphics_jobs')
    .select('id, job_number, title')
    .eq('id', params.id)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const { data: files } = await supabase
    .from('graphics_job_files')
    .select('id, file_name, storage_path')
    .eq('job_id', job.id)
    .order('uploaded_at', { ascending: true });

  if (!files || files.length === 0) {
    return NextResponse.json({ error: 'No files attached to this job' }, { status: 404 });
  }

  const zip = new JSZip();
  const usedNames = new Map<string, number>();
  const errors: string[] = [];

  for (const f of files) {
    try {
      const result = await r2Get(FILE_BUCKET_PREFIX, f.storage_path);
      if (!result.success || !result.body) {
        errors.push(`${f.file_name}: ${result.error || 'fetch failed'}`);
        continue;
      }
      const bytes = await readAll(result.body);

      const safe = sanitize(f.file_name, 'file');
      const dot = safe.lastIndexOf('.');
      const stem = dot > 0 ? safe.slice(0, dot) : safe;
      const ext = dot > 0 ? safe.slice(dot) : '';
      const seen = usedNames.get(safe) || 0;
      const finalName = seen === 0 ? safe : `${stem} (${seen})${ext}`;
      usedNames.set(safe, seen + 1);

      zip.file(finalName, bytes);
    } catch (e: any) {
      errors.push(`${f.file_name}: ${e?.message || 'unknown error'}`);
    }
  }

  if (Object.keys(zip.files).length === 0) {
    return NextResponse.json(
      { error: 'Could not fetch any files from storage', detail: errors },
      { status: 502 }
    );
  }

  const buffer = await zip.generateAsync({ type: 'uint8array' });
  const archiveStem = sanitize(
    [job.job_number ? `Job-${job.job_number}` : null, job.title].filter(Boolean).join(' - '),
    `graphics-job-${job.id.slice(0, 8)}`,
  );

  return new Response(buffer as any, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${archiveStem}.zip"`,
      'Content-Length': String(buffer.byteLength),
      'Cache-Control': 'no-store',
    },
  });
}
