#!/usr/bin/env node
/**
 * Apply the CORS rules the browser needs for direct-to-R2 presigned uploads.
 *
 * The app normally applies these automatically (ensureR2Cors() runs before
 * every presign), but that only works if the R2 API key in the deployed
 * environment has bucket-config permission. If the server logs show
 * AccessDenied from ensureR2Cors, run this once with an Admin Read & Write
 * key (Cloudflare dashboard → R2 → Manage API Tokens):
 *
 *   node scripts/setup-r2-cors.mjs
 *
 * Reads R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and
 * R2_BUCKET_NAME from the environment or .env.local / .env.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { S3Client, GetBucketCorsCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: path.join(root, '.env.local') });
dotenv.config({ path: path.join(root, '.env') });

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET_NAME || 'fleetsuite';

if (!accountId || !accessKeyId || !secretAccessKey) {
  console.error('Missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY (set them in .env.local).');
  process.exit(1);
}

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

// Same rules as ensureR2Cors() in src/lib/r2.ts — writes are gated by the
// presigned signature, not by CORS, so '*' origins is fine and also covers
// the Capacitor app shells and Vercel preview URLs.
const CORSRules = [
  {
    AllowedOrigins: ['*'],
    AllowedMethods: ['GET', 'PUT', 'HEAD'],
    AllowedHeaders: ['*'],
    ExposeHeaders: ['etag'],
    MaxAgeSeconds: 3600,
  },
];

try {
  const current = await client.send(new GetBucketCorsCommand({ Bucket: bucket })).catch(err => {
    if (err?.name === 'NoSuchCORSConfiguration' || err?.Code === 'NoSuchCORSConfiguration') return null;
    throw err;
  });
  console.log('Current CORS rules:', JSON.stringify(current?.CORSRules ?? null, null, 2));
  await client.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules } }));
  console.log(`✔ CORS rules applied to bucket "${bucket}". Browser uploads should work now.`);
} catch (err) {
  console.error('Failed to apply CORS rules:', err?.message || err);
  console.error('Make sure the key is an R2 API token with Admin Read & Write on this bucket.');
  process.exit(1);
}
