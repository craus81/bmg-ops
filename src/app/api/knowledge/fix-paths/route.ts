import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function getR2Client() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

// Strip timestamp prefix: "1774369987708_WrapDimensions_pa..." → "WrapDimensions_pa..."
function stripTimestamp(name: string): string {
  return name.replace(/^\d+_/, '');
}

export async function POST(req: NextRequest) {
  try {
    const { dryRun = true } = await req.json().catch(() => ({ dryRun: true }));
    const bucket = process.env.R2_BUCKET_NAME || 'fleetsuite';
    const s3 = getR2Client();

    // 1. List all files in R2 under knowledge-files/uploads/
    const r2Files: { relativePath: string; baseName: string; size: number }[] = [];
    let continuationToken: string | undefined;

    do {
      const result = await s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: 'knowledge-files/uploads/',
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      }));

      if (result.Contents) {
        for (const obj of result.Contents) {
          const relativePath = obj.Key!.replace(/^knowledge-files\//, '');
          const fileName = relativePath.replace(/^uploads\//, '');
          r2Files.push({
            relativePath,
            baseName: stripTimestamp(fileName),
            size: obj.Size || 0,
          });
        }
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    // 2. Get all knowledge docs with file_path set
    const { data: docs, error: dbErr } = await supabase
      .from('knowledge_docs')
      .select('id, title, file_name, file_path, file_size')
      .not('file_path', 'is', null)
      .order('created_at', { ascending: true });

    if (dbErr) {
      return NextResponse.json({ error: 'DB error: ' + dbErr.message }, { status: 500 });
    }

    // 3. Build baseName → R2 files map
    const r2ByBase = new Map<string, typeof r2Files>();
    for (const f of r2Files) {
      if (!r2ByBase.has(f.baseName)) r2ByBase.set(f.baseName, []);
      r2ByBase.get(f.baseName)!.push(f);
    }

    // 4. Match DB records to R2 files
    const updates: { id: string; title: string; oldPath: string; newPath: string }[] = [];
    let alreadyCorrect = 0;
    let noMatch = 0;
    const noMatchList: string[] = [];

    for (const doc of docs!) {
      const dbFileName = doc.file_path.replace(/^uploads\//, '');
      const dbBaseName = stripTimestamp(dbFileName);

      // Check if current path already exists in R2
      if (r2Files.some(f => f.relativePath === doc.file_path)) {
        alreadyCorrect++;
        continue;
      }

      // Match by base name
      const candidates = r2ByBase.get(dbBaseName) || [];

      if (candidates.length === 0) {
        noMatch++;
        noMatchList.push(`${doc.title} (${dbBaseName})`);
      } else {
        // Prefer size match, otherwise pick first
        const best = candidates.find(c => c.size === doc.file_size) || candidates[0];
        updates.push({
          id: doc.id,
          title: doc.title,
          oldPath: doc.file_path,
          newPath: best.relativePath,
        });
      }
    }

    // 5. Apply updates if not dry run
    let applied = 0;
    let failed = 0;

    if (!dryRun && updates.length > 0) {
      for (const u of updates) {
        const { error } = await supabase
          .from('knowledge_docs')
          .update({ file_path: u.newPath })
          .eq('id', u.id);

        if (error) {
          failed++;
        } else {
          applied++;
        }
      }
    }

    return NextResponse.json({
      r2FileCount: r2Files.length,
      dbDocCount: docs!.length,
      alreadyCorrect,
      matched: updates.length,
      noMatch,
      noMatchList: noMatchList.slice(0, 20),
      sampleUpdates: updates.slice(0, 5).map(u => ({
        title: u.title,
        oldPath: u.oldPath,
        newPath: u.newPath,
      })),
      dryRun,
      applied,
      failed,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
