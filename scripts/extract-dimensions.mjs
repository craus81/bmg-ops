#!/usr/bin/env node
/**
 * Extract vehicle wrap dimensions from PDFs in R2 knowledge_files folder.
 *
 * Scans R2 for wrap dimension PDFs, sends each to Claude Vision to extract
 * panel dimensions, and upserts into the vehicle_templates table.
 *
 * Usage:
 *   node scripts/extract-dimensions.mjs                    # Process all files
 *   node scripts/extract-dimensions.mjs --dry-run          # Preview without writing to DB
 *   node scripts/extract-dimensions.mjs --prefix "Ford"    # Only process files matching prefix
 *   node scripts/extract-dimensions.mjs --file "Transit_wrapdimensions.pdf"  # Process single file
 *
 * Required env vars:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *   ANTHROPIC_API_KEY
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import 'dotenv/config';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';

// ── Config ──
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET_NAME || 'fleetsuite';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.error('Missing R2 environment variables');
  process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing Supabase environment variables');
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const PREFIX_FILTER = args.includes('--prefix') ? args[args.indexOf('--prefix') + 1] : null;
const SINGLE_FILE = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Claude Vision extraction prompt ──
const EXTRACTION_PROMPT = `You are analyzing a vehicle wrap dimensions template sheet. This is a technical document showing a vehicle from multiple angles (driver side, passenger side, front, rear, top/roof) with exact panel dimensions.

Extract ALL of the following information:

1. VEHICLE INFO:
   - make (e.g., "Chevrolet", "Ford", "Mercedes-Benz")
   - model (e.g., "Express", "Transit", "Sprinter")
   - year_range (e.g., "2003-Present", "2015-2023")
   - variant (e.g., "Short Wheelbase", "Long Wheelbase", "High Roof", "Extended") or null
   - overall_length_in: overall vehicle length in inches (from the dimension labels)
   - overall_height_in: overall height in inches
   - wheelbase_in: wheelbase in inches

2. PANEL DIMENSIONS:
   Look for a dimension table or labeled panels (usually labeled A through H or similar).
   For EACH panel, extract:
   - name: descriptive name ("Driver Side", "Passenger Side", "Rear", "Hood/Front", "Roof", "Rear Upper", "Rear Quarter", etc.)
   - label: the letter label (A, B, C, etc.)
   - width_in: width in inches
   - height_in: height in inches
   - area_sqft: total square feet (if listed), otherwise calculate: (width_in × height_in) / 144

Return ONLY valid JSON, no markdown, no backticks:
{
  "make": "Chevrolet",
  "model": "Express",
  "year_range": "2003-Present",
  "variant": "Short Wheelbase",
  "overall_length_in": 217.4,
  "overall_height_in": 72,
  "wheelbase_in": 135,
  "panels": [
    {"name": "Driver Side", "label": "A", "width_in": 222, "height_in": 72, "area_sqft": 111.00},
    {"name": "Passenger Side", "label": "B", "width_in": 222, "height_in": 72, "area_sqft": 111.00}
  ],
  "source_notes": "Art Station template, file Exp_year_01"
}

IMPORTANT:
- Extract dimensions in INCHES (convert from mm if needed: mm ÷ 25.4 = inches)
- If a panel is listed as "N/A", skip it
- Include ALL panels shown in the dimension table
- If there are window film dimensions, include those panels separately with "(Window Film)" in the name`;

// ── List R2 files ──
async function listFiles() {
  const prefix = 'knowledge_files/';
  const files = [];
  let continuationToken;

  do {
    const cmd = new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 100,
    });
    const result = await s3.send(cmd);
    for (const obj of (result.Contents || [])) {
      const key = obj.Key || '';
      const fileName = key.replace(prefix, '');

      // Filter to dimension/wrap files (PDFs and images)
      if (!fileName) continue;
      const isRelevant = /wrap.*dim|dim.*wrap|template|_wd\b/i.test(fileName) ||
                          /\.(pdf|png|jpg|jpeg)$/i.test(fileName);

      if (SINGLE_FILE && !fileName.includes(SINGLE_FILE)) continue;
      if (PREFIX_FILTER && !fileName.toLowerCase().startsWith(PREFIX_FILTER.toLowerCase())) continue;

      if (isRelevant) {
        files.push({ key, fileName, size: obj.Size });
      }
    }
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  return files;
}

// ── Download file from R2 ──
async function downloadFile(key) {
  const result = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of result.Body) {
    chunks.push(chunk);
  }
  return {
    buffer: Buffer.concat(chunks),
    contentType: result.ContentType || 'application/octet-stream',
  };
}

// ── Send to Claude Vision ──
async function extractDimensions(base64Data, mediaType) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'pdfs-2024-09-25',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          {
            type: mediaType === 'application/pdf' ? 'document' : 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Data,
            },
          },
          { type: 'text', text: EXTRACTION_PROMPT },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';

  // Parse JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in Claude response');
  return JSON.parse(jsonMatch[0]);
}

// ── Upsert into vehicle_templates ──
async function upsertTemplate(extracted, sourceFile) {
  const { make, model, year_range, variant, overall_length_in, overall_height_in, wheelbase_in, panels } = extracted;

  if (!make || !model) {
    console.warn(`  ⚠ Skipping — no make/model extracted`);
    return null;
  }

  // Format panel_data
  const panelData = (panels || []).map(p => ({
    name: p.name,
    label: p.label || null,
    width_in: parseFloat(p.width_in) || 0,
    height_in: parseFloat(p.height_in) || 0,
    area_sqft: parseFloat(p.area_sqft) || Math.round((p.width_in * p.height_in) / 144 * 100) / 100,
  }));

  // Parse year from year_range (take the first year)
  const yearMatch = year_range?.match(/(\d{4})/);
  const year = yearMatch ? yearMatch[1] : null;

  const templateName = [make, model, variant, year_range].filter(Boolean).join(' ');

  // Check if template already exists for this make/model/variant
  let query = supabase
    .from('vehicle_templates')
    .select('id')
    .ilike('make', make)
    .ilike('model', model);

  if (variant) {
    query = query.ilike('variant', variant);
  } else {
    query = query.is('variant', null);
  }

  const { data: existing } = await query.limit(1);

  const record = {
    name: templateName,
    make,
    model,
    year: year || null,
    variant: variant || null,
    scale: '1:20',
    overall_length_in: parseFloat(overall_length_in) || null,
    overall_height_in: parseFloat(overall_height_in) || null,
    wheelbase_in: parseFloat(wheelbase_in) || null,
    panel_data: panelData,
    updated_at: new Date().toISOString(),
  };

  if (existing && existing.length > 0) {
    // Update existing
    const { error } = await supabase
      .from('vehicle_templates')
      .update(record)
      .eq('id', existing[0].id);

    if (error) throw new Error(`Update failed: ${error.message}`);
    console.log(`  ✅ Updated: ${templateName} (${panelData.length} panels)`);
    return existing[0].id;
  } else {
    // Insert new
    const { data: inserted, error } = await supabase
      .from('vehicle_templates')
      .insert({ ...record, created_at: new Date().toISOString() })
      .select('id')
      .single();

    if (error) throw new Error(`Insert failed: ${error.message}`);
    console.log(`  ✅ Created: ${templateName} (${panelData.length} panels)`);
    return inserted.id;
  }
}

// ── Main ──
async function main() {
  console.log('🔍 Scanning R2 for wrap dimension files...');
  if (DRY_RUN) console.log('   (DRY RUN — no database writes)');

  const files = await listFiles();
  console.log(`📄 Found ${files.length} dimension files\n`);

  if (files.length === 0) {
    console.log('No matching files found. Try without --prefix or --file filters.');
    console.log('Files should be in: knowledge_files/ prefix in R2');
    return;
  }

  let processed = 0;
  let errors = 0;

  for (const file of files) {
    console.log(`📋 Processing: ${file.fileName} (${(file.size / 1024).toFixed(0)} KB)`);

    try {
      // Skip files over 20MB (Claude's limit per document)
      if (file.size > 20 * 1024 * 1024) {
        console.log(`  ⚠ Skipping — file too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 20MB per file.`);
        continue;
      }

      // Download
      const { buffer, contentType } = await downloadFile(file.key);
      const base64 = buffer.toString('base64');

      // Determine media type
      let mediaType = contentType;
      if (file.fileName.endsWith('.pdf')) mediaType = 'application/pdf';
      else if (file.fileName.endsWith('.png')) mediaType = 'image/png';
      else if (file.fileName.match(/\.jpe?g$/)) mediaType = 'image/jpeg';

      // Extract via Claude Vision
      const extracted = await extractDimensions(base64, mediaType);
      console.log(`  📐 Extracted: ${extracted.make} ${extracted.model} ${extracted.variant || ''} — ${(extracted.panels || []).length} panels`);

      if (DRY_RUN) {
        console.log(`  📊 Panels:`);
        for (const p of (extracted.panels || [])) {
          console.log(`     ${p.label || '?'}) ${p.name}: ${p.width_in}" × ${p.height_in}" = ${p.area_sqft} sqft`);
        }
      } else {
        await upsertTemplate(extracted, file.fileName);
      }

      processed++;

      // Rate limit: 1 second between API calls
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`  ❌ Error: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n✅ Done! Processed ${processed} files, ${errors} errors.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
