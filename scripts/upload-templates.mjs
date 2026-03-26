#!/usr/bin/env node

/**
 * Convert EPS templates to PNG locally and upload PNGs to R2
 *
 * Reads a local directory (e.g. your OFFICE folder), converts each EPS to PNG
 * via Ghostscript, and uploads the PNG to R2 under vehicle-templates/previews/
 *
 * Prerequisites:
 *   brew install ghostscript
 *
 * Usage:
 *   node scripts/upload-templates.mjs /path/to/OFFICE
 *
 * Example:
 *   node scripts/upload-templates.mjs ~/Dropbox/OFFICE
 *
 * The folder structure should be:
 *   OFFICE/
 *     Make/
 *       Model/
 *         Year/
 *           file.eps
 *
 * PNGs will be uploaded as:
 *   vehicle-templates/previews/Make/Model/Year/file.png
 *
 * Options:
 *   --dry-run     List files without converting or uploading
 *   --force       Re-upload files even if they already exist in R2
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync, readdirSync, statSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'fs';
import { resolve, relative, extname, basename } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';

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

// Check Ghostscript is installed
try {
  execSync('gs --version', { stdio: 'pipe' });
} catch {
  console.error('ERROR: Ghostscript not found. Install it with: brew install ghostscript');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');

// Get the source folder from args (filter out flags)
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const sourceFolder = args[0];

if (!sourceFolder) {
  console.error('ERROR: Please provide the path to your template folder');
  console.error('');
  console.error('Usage:');
  console.error('  node scripts/upload-templates.mjs /path/to/OFFICE');
  console.error('  node scripts/upload-templates.mjs ~/Dropbox/OFFICE --dry-run');
  process.exit(1);
}

const resolvedSource = resolve(sourceFolder);

try {
  const stat = statSync(resolvedSource);
  if (!stat.isDirectory()) {
    console.error(`ERROR: ${resolvedSource} is not a directory`);
    process.exit(1);
  }
} catch {
  console.error(`ERROR: ${resolvedSource} does not exist`);
  process.exit(1);
}

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

const R2_PREFIX = 'vehicle-templates/previews/';
const TMP_DIR = resolve(tmpdir(), 'eps-to-png-convert');

// ── Recursively find all EPS files ──
function findEpsFiles(dir) {
  const results = [];
  const entries = readdirSync(dir);

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;

    const fullPath = resolve(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      results.push(...findEpsFiles(fullPath));
    } else if (extname(entry).toLowerCase() === '.eps') {
      results.push(fullPath);
    }
  }

  return results;
}

// ── Check if file already exists in R2 ──
async function existsInR2(key) {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

// ── Convert EPS to PNG using Ghostscript ──
function convertEpsToPng(epsPath, pngPath) {
  execSync(`gs -dNOPAUSE -dBATCH -dSAFER -sDEVICE=png16m -r150 -dTextAlphaBits=4 -dGraphicsAlphaBits=4 -sOutputFile="${pngPath}" "${epsPath}"`, {
    stdio: 'pipe',
    timeout: 60000, // 60s timeout per file
  });
}

// ── Upload a buffer to R2 ──
async function uploadToR2(key, buffer) {
  await r2.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: 'image/png',
  }));
  return buffer.length;
}

// ── Main ──
async function main() {
  console.log(`📂 Scanning for EPS files in: ${resolvedSource}\n`);

  const epsFiles = findEpsFiles(resolvedSource);
  console.log(`Found ${epsFiles.length} EPS file(s)\n`);

  if (epsFiles.length === 0) {
    console.log('No EPS files found. Check that the folder contains .eps files.');
    return;
  }

  if (dryRun) {
    console.log('DRY RUN — would convert & upload:\n');
    for (const filePath of epsFiles) {
      const relativePath = relative(resolvedSource, filePath);
      const pngRelative = relativePath.replace(/\.eps$/i, '.png');
      const r2Key = R2_PREFIX + pngRelative;
      const sizeKB = (statSync(filePath).size / 1024).toFixed(1);
      console.log(`  ${relativePath} → ${r2Key} (EPS: ${sizeKB} KB)`);
    }
    console.log(`\nTotal: ${epsFiles.length} files`);
    return;
  }

  // Create temp directory
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

  let uploaded = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < epsFiles.length; i++) {
    const filePath = epsFiles[i];
    const relativePath = relative(resolvedSource, filePath);
    const pngRelative = relativePath.replace(/\.eps$/i, '.png');
    const r2Key = R2_PREFIX + pngRelative;

    process.stdout.write(`[${i + 1}/${epsFiles.length}] ${relativePath} ... `);

    // Skip if already exists (unless --force)
    if (!force) {
      try {
        if (await existsInR2(r2Key)) {
          console.log('⏭️  already exists');
          skipped++;
          continue;
        }
      } catch { /* proceed */ }
    }

    const tmpEps = resolve(TMP_DIR, `input_${i}.eps`);
    const tmpPng = resolve(TMP_DIR, `output_${i}.png`);

    try {
      // Copy EPS to temp (in case Dropbox path has spaces/special chars)
      writeFileSync(tmpEps, readFileSync(filePath));

      // Convert EPS → PNG
      convertEpsToPng(tmpEps, tmpPng);

      if (!existsSync(tmpPng)) {
        throw new Error('Ghostscript did not produce output');
      }

      // Upload PNG to R2
      const pngBuffer = readFileSync(tmpPng);
      const bytes = await uploadToR2(r2Key, pngBuffer);
      const sizeKB = (bytes / 1024).toFixed(1);
      console.log(`✅ (${sizeKB} KB)`);
      uploaded++;
    } catch (err) {
      console.log(`❌ ${err.message}`);
      errors++;
    } finally {
      try { rmSync(tmpEps, { force: true }); } catch {}
      try { rmSync(tmpPng, { force: true }); } catch {}
    }
  }

  // Cleanup temp dir
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}

  console.log('\n' + '═'.repeat(40));
  console.log(`✅ Upload complete!`);
  console.log(`   Converted & uploaded: ${uploaded}`);
  console.log(`   Skipped (already exist): ${skipped}`);
  console.log(`   Errors: ${errors}`);

  if (uploaded > 0) {
    console.log(`\n💡 Next step: populate the database with:`);
    console.log(`   node scripts/populate-templates-db.mjs`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
