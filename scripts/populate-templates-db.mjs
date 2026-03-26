#!/usr/bin/env node

/**
 * Populate vehicle_templates table from PNG files in R2
 *
 * Scans the vehicle-templates/previews/ prefix in R2, extracts make/model/year
 * from the folder structure, and inserts records into the vehicle_templates
 * table in Supabase.
 *
 * Folder structure expected:
 *   vehicle-templates/previews/{Make}/{Model}/{Year}/file.png
 *
 * Usage:
 *   node scripts/populate-templates-db.mjs
 *
 * Options:
 *   --dry-run     Show what would be inserted without touching the database
 *   --force       Re-insert even if a matching template already exists
 *   --clear       Delete all existing vehicle_templates records first (use with caution!)
 */

import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
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

// ── Config ──
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET_NAME || 'fleetsuite';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.error('ERROR: Missing R2 credentials in .env.local');
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');
const clear = process.argv.includes('--clear');

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const PREVIEWS_PREFIX = 'vehicle-templates/previews/';

// ── List all PNG files under previews/ ──
async function listPngFiles() {
  const files = [];
  let continuationToken;

  do {
    const cmd = new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: PREVIEWS_PREFIX,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    });
    const result = await r2.send(cmd);

    if (result.Contents) {
      for (const obj of result.Contents) {
        if (obj.Key && obj.Key.toLowerCase().endsWith('.png')) {
          files.push(obj.Key);
        }
      }
    }

    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  return files;
}

// ── Parse the R2 key into template metadata ──
// Expected: vehicle-templates/previews/{Make}/{Model}/{Year}/filename.png
// Or deeper: vehicle-templates/previews/{Make}/{Model}/{BodyStyle}/{Year}/filename.png
function parseTemplatePath(key) {
  const relativePath = key.replace(PREVIEWS_PREFIX, '');
  const parts = relativePath.split('/');
  const filename = parts[parts.length - 1];
  const nameWithoutExt = filename.replace(/\.png$/i, '');

  if (parts.length < 3) {
    // Not enough folder depth — skip
    return null;
  }

  let make, model, year, variant;

  if (parts.length === 4) {
    // Make/Model/Year/file.png — most common
    [make, model, year] = parts;
  } else if (parts.length === 5) {
    // Make/Model/BodyStyle/Year/file.png
    make = parts[0];
    model = parts[1];
    variant = parts[2];
    year = parts[3];
  } else if (parts.length >= 6) {
    // Make/Model/BodyStyle/SubVariant/Year/file.png — deeper nesting
    make = parts[0];
    model = parts[1];
    variant = parts.slice(2, parts.length - 2).join(' ');
    year = parts[parts.length - 2];
  } else {
    // Make/Model/file.png (no year folder)
    make = parts[0];
    model = parts[1];
    year = null;
  }

  // Clean up the name — use filename as display name, replacing dashes/underscores with spaces
  const displayName = nameWithoutExt
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Build a friendly template name
  const templateName = [make, model, variant, year, displayName !== model ? displayName : null]
    .filter(Boolean)
    .join(' ');

  return {
    make: make || 'Unknown',
    model: model || 'Unknown',
    year: year || null,
    variant: variant || null,
    name: templateName,
    // Path relative to the vehicle-templates bucket (what the app expects)
    template_image_path: `previews/${relativePath}`,
    filename,
  };
}

// ── Main ──
async function main() {
  console.log('🔍 Scanning R2 for vehicle template PNG files...\n');

  const pngFiles = await listPngFiles();
  console.log(`Found ${pngFiles.length} PNG file(s)\n`);

  if (pngFiles.length === 0) {
    console.log('No PNG files found under vehicle-templates/previews/');
    console.log('Upload templates first with: node scripts/upload-templates.mjs /path/to/OFFICE');
    return;
  }

  // Parse all templates
  const templates = [];
  for (const key of pngFiles) {
    const parsed = parseTemplatePath(key);
    if (parsed) {
      templates.push(parsed);
    } else {
      console.warn(`⚠️  Skipping (can't parse path): ${key}`);
    }
  }

  console.log(`Parsed ${templates.length} template(s)\n`);

  if (dryRun) {
    console.log('DRY RUN — would insert:\n');
    for (const t of templates) {
      console.log(`  ${t.name}`);
      console.log(`    Make: ${t.make} | Model: ${t.model} | Year: ${t.year || 'N/A'} | Variant: ${t.variant || 'N/A'}`);
      console.log(`    PNG: ${t.template_image_path}`);
      console.log('');
    }
    console.log(`Total: ${templates.length} templates`);
    return;
  }

  // Clear existing records if --clear flag
  if (clear) {
    console.log('🗑️  Clearing existing vehicle_templates records...');
    const { error } = await supabase.from('vehicle_templates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) {
      console.error('Failed to clear table:', error.message);
      process.exit(1);
    }
    console.log('   Done.\n');
  }

  // Get existing templates to avoid duplicates (check by template_image_path)
  let existingPaths = new Set();
  if (!force) {
    const { data: existing } = await supabase
      .from('vehicle_templates')
      .select('template_image_path');
    if (existing) {
      existingPaths = new Set(existing.map(e => e.template_image_path));
    }
  }

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    process.stdout.write(`[${i + 1}/${templates.length}] ${t.name} ... `);

    // Check for existing record
    if (!force && existingPaths.has(t.template_image_path)) {
      console.log('⏭️  already in database');
      skipped++;
      continue;
    }

    const record = {
      name: t.name,
      make: t.make,
      model: t.model,
      year: t.year,
      variant: t.variant,
      template_image_path: t.template_image_path,
      original_file_path: null, // No EPS stored in R2
      scale: '1:20',
    };

    try {
      const { error: insertError } = await supabase
        .from('vehicle_templates')
        .insert(record);

      if (insertError) {
        console.log(`❌ ${insertError.message}`);
        errors++;
      } else {
        console.log('✅');
        inserted++;
      }
    } catch (err) {
      console.log(`❌ ${err.message}`);
      errors++;
    }
  }

  console.log('\n' + '═'.repeat(50));
  console.log('✅ Database population complete!');
  console.log(`   Inserted: ${inserted}`);
  console.log(`   Skipped (already exist): ${skipped}`);
  console.log(`   Errors: ${errors}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
