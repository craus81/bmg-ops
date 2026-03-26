#!/usr/bin/env node

/**
 * Delete all files under vehicle-templates/originals/ in R2
 *
 * Usage:
 *   node scripts/delete-r2-originals.mjs --dry-run   (list what would be deleted)
 *   node scripts/delete-r2-originals.mjs              (actually delete)
 */

import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Load .env.local ──
function loadEnv() {
  try {
    const envPath = resolve(process.cwd(), '.env.local');
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch { /* no .env.local */ }
}
loadEnv();

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET_NAME || 'fleetsuite';

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.error('ERROR: Missing R2 credentials in .env.local');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

const PREFIX = 'vehicle-templates/originals/';

async function main() {
  console.log(`🔍 Listing files under ${PREFIX} ...\n`);

  const allKeys = [];
  let continuationToken;

  do {
    const result = await r2.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: PREFIX,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));

    if (result.Contents) {
      for (const obj of result.Contents) {
        if (obj.Key) allKeys.push(obj.Key);
      }
    }
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  console.log(`Found ${allKeys.length} file(s)\n`);

  if (allKeys.length === 0) {
    console.log('Nothing to delete.');
    return;
  }

  if (dryRun) {
    console.log('DRY RUN — would delete:\n');
    for (const key of allKeys) {
      console.log(`  ${key}`);
    }
    console.log(`\nTotal: ${allKeys.length} files`);
    return;
  }

  // R2 DeleteObjects supports up to 1000 keys per batch
  let deleted = 0;
  for (let i = 0; i < allKeys.length; i += 1000) {
    const batch = allKeys.slice(i, i + 1000);
    process.stdout.write(`Deleting batch ${Math.floor(i / 1000) + 1} (${batch.length} files) ... `);

    await r2.send(new DeleteObjectsCommand({
      Bucket: R2_BUCKET,
      Delete: {
        Objects: batch.map(Key => ({ Key })),
        Quiet: true,
      },
    }));

    deleted += batch.length;
    console.log('✅');
  }

  console.log(`\n✅ Deleted ${deleted} file(s) from ${PREFIX}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
