#!/usr/bin/env node
/**
 * Delete vehicle template images from R2.
 * These are no longer needed — the quoting system now uses panel dimension
 * data instead of template images for AI analysis.
 *
 * Usage:
 *   node scripts/delete-r2-templates.mjs --dry-run    # Preview what would be deleted
 *   node scripts/delete-r2-templates.mjs              # Actually delete
 *
 * Required env vars (in .env.local):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 */

import 'dotenv/config';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET_NAME || 'fleetsuite';

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.error('Missing R2 environment variables');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

async function main() {
  console.log('🔍 Scanning R2 for vehicle template images...');
  if (DRY_RUN) console.log('   (DRY RUN — nothing will be deleted)\n');

  const prefix = 'vehicle-templates/';
  let allKeys = [];
  let continuationToken;

  do {
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));

    for (const obj of (result.Contents || [])) {
      allKeys.push(obj.Key);
      if (DRY_RUN) {
        console.log(`  📄 ${obj.Key} (${(obj.Size / 1024).toFixed(1)} KB)`);
      }
    }
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  console.log(`\n📊 Found ${allKeys.length} files under ${prefix}`);

  if (allKeys.length === 0) {
    console.log('Nothing to delete.');
    return;
  }

  if (DRY_RUN) {
    const totalMB = allKeys.length > 0 ? 'unknown' : '0';
    console.log(`\n⚡ DRY RUN complete. Run without --dry-run to delete ${allKeys.length} files.`);
    return;
  }

  // Batch delete (max 1000 keys per request)
  const batchSize = 1000;
  let deleted = 0;

  for (let i = 0; i < allKeys.length; i += batchSize) {
    const batch = allKeys.slice(i, i + batchSize);
    await s3.send(new DeleteObjectsCommand({
      Bucket: R2_BUCKET,
      Delete: { Objects: batch.map(Key => ({ Key })) },
    }));
    deleted += batch.length;
    console.log(`  🗑️ Deleted ${deleted}/${allKeys.length} files...`);
  }

  console.log(`\n✅ Done! Deleted ${deleted} template files from R2.`);
  console.log('   Note: Also clear template_image_path in vehicle_templates table:');
  console.log('   UPDATE vehicle_templates SET template_image_path = NULL;');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
