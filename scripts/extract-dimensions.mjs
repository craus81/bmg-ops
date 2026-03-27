#!/usr/bin/env node
/**
 * Extract vehicle wrap dimensions from PDFs in R2 knowledge_files folder.
 *
 * Each PDF contains MULTIPLE vehicles (e.g., 25-30 per file, ~550 total across ~20 files).
 * The script sends each PDF to Claude, extracts ALL vehicles and their panel dimensions,
 * and upserts each into the vehicle_templates table.
 *
 * Usage:
 *   node scripts/extract-dimensions.mjs                    # Process all files
 *   node scripts/extract-dimensions.mjs --dry-run          # Preview without writing to DB
 *   node scripts/extract-dimensions.mjs --prefix "Ford"    # Only process files matching prefix
 *   node scripts/extract-dimensions.mjs --file "Transit_wrapdimensions.pdf"  # Process single file
 *
 * Required env vars (in .env.local):
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
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.error('❌ Missing R2 environment variables');
  process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
  console.error('❌ Missing ANTHROPIC_API_KEY');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing Supabase environment variables');
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

// ── Claude extraction prompt for MULTI-VEHICLE PDFs ──
const EXTRACTION_PROMPT = `You are analyzing a PDF that contains wrap dimension sheets for MULTIPLE vehicles. Each vehicle typically takes 1 page and shows the vehicle from multiple angles (driver side, passenger side, front, rear, top/roof) with a dimension table.

You MUST extract ALL vehicles in this document — there may be 20-40+ vehicles per file.

For EACH vehicle in the document, extract:

1. VEHICLE INFO:
   - make (e.g., "Chevrolet", "Ford", "Mercedes-Benz", "RAM", "GMC")
   - model (e.g., "Express", "Transit", "Sprinter", "ProMaster")
   - year_range (e.g., "2003-Present", "2015-2023")
   - variant (e.g., "Short Wheelbase", "Long Wheelbase", "High Roof", "Extended", "Crew Cab") or null
   - overall_length_in: overall vehicle length in inches
   - overall_height_in: overall height in inches
   - wheelbase_in: wheelbase in inches

2. PANEL DIMENSIONS (from the dimension table, usually labeled A through H):
   - name: descriptive name ("Driver Side", "Passenger Side", "Rear", "Hood/Front", "Roof", etc.)
   - label: the letter label (A, B, C, etc.)
   - width_in: width in inches
   - height_in: height in inches
   - area_sqft: total square feet (from the table, or calculate: width_in × height_in / 144)

Return ONLY valid JSON, no markdown, no backticks. The response must be a JSON array of ALL vehicles:
{
  "vehicles": [
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
      "page_number": 1
    },
    {
      "make": "Ford",
      "model": "Transit",
      "year_range": "2015-Present",
      "variant": "Long Wheelbase High Roof",
      "overall_length_in": 263.9,
      "overall_height_in": 110,
      "wheelbase_in": 148,
      "panels": [
        {"name": "Driver Side", "label": "A", "width_in": 270, "height_in": 96, "area_sqft": 180.00}
      ],
      "page_number": 2
    }
  ],
  "total_vehicles_found": 2,
  "source_file": "filename.pdf"
}

CRITICAL RULES:
- Extract EVERY vehicle in the document. Do not stop early.
- Dimensions must be in INCHES (convert from mm if needed: mm ÷ 25.4 = inches)
- Skip panels listed as "N/A"
- Include window film panels separately with "(Window Film)" in the name
- If a vehicle has multiple variants (e.g., short vs long wheelbase), list each as a separate vehicle
- page_number should be the approximate page in the PDF where this vehicle appears`;

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

      if (!fileName) continue;

      if (SINGLE_FILE && !fileName.includes(SINGLE_FILE)) continue;
      if (PREFIX_FILTER && !fileName.toLowerCase().includes(PREFIX_FILTER.toLowerCase())) continue;

      // Accept PDFs, PNGs, JPGs in the knowledge_files folder
      if (/\.(pdf|png|jpg|jpeg)$/i.test(fileName)) {
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

// ── Send to Claude ──
async function extractFromPDF(base64Data, mediaType, fileName) {
  // For large PDFs (>5MB base64), Claude may need more tokens
  const maxTokens = 16384;

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
      max_tokens: maxTokens,
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
          {
            type: 'text',
            text: `${EXTRACTION_PROMPT}\n\nSource file: ${fileName}`,
          },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errText.substring(0, 500)}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';

  // Check if response was truncated (hit token limit)
  const stopReason = data.stop_reason;
  if (stopReason === 'max_tokens') {
    console.warn(`  ⚠ Response was truncated (hit ${maxTokens} token limit). Some vehicles may be missing.`);
  }

  // Parse JSON — look for the vehicles array
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in Claude response');

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    // If JSON was truncated, try to salvage what we can
    const partialMatch = text.match(/\{[\s\S]*"vehicles"\s*:\s*\[([\s\S]*)\]/);
    if (partialMatch) {
      // Try to find the last complete vehicle object
      const vehiclesStr = partialMatch[1];
      const lastBrace = vehiclesStr.lastIndexOf('}');
      if (lastBrace > 0) {
        const trimmed = vehiclesStr.substring(0, lastBrace + 1);
        try {
          parsed = { vehicles: JSON.parse(`[${trimmed}]`) };
          console.warn(`  ⚠ Salvaged ${parsed.vehicles.length} vehicles from truncated response`);
        } catch {
          throw new Error('Could not parse truncated JSON response');
        }
      }
    }
    if (!parsed) throw new Error(`JSON parse error: ${e.message}`);
  }

  return parsed;
}

// ── Upsert one vehicle into vehicle_templates ──
async function upsertTemplate(vehicle, sourceFile) {
  const { make, model, year_range, variant, overall_length_in, overall_height_in, wheelbase_in, panels } = vehicle;

  if (!make || !model) {
    console.warn(`    ⚠ Skipping — no make/model extracted`);
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

  // Parse year from year_range
  const yearMatch = year_range?.match(/(\d{4})/);
  const year = yearMatch ? yearMatch[1] : null;

  const templateName = [make, model, variant, year_range].filter(Boolean).join(' ');

  // Check for existing template (make + model + variant)
  let query = supabase
    .from('vehicle_templates')
    .select('id')
    .ilike('make', make)
    .ilike('model', model);

  if (variant) {
    query = query.ilike('variant', `%${variant}%`);
  } else {
    query = query.or('variant.is.null,variant.eq.');
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
    template_image_path: null,
    original_file_path: null,
    updated_at: new Date().toISOString(),
  };

  if (existing && existing.length > 0) {
    const { error } = await supabase
      .from('vehicle_templates')
      .update(record)
      .eq('id', existing[0].id);

    if (error) throw new Error(`Update failed: ${error.message}`);
    return { action: 'updated', id: existing[0].id, name: templateName, panels: panelData.length };
  } else {
    const { data: inserted, error } = await supabase
      .from('vehicle_templates')
      .insert({ ...record, created_at: new Date().toISOString() })
      .select('id')
      .single();

    if (error) throw new Error(`Insert failed: ${error.message}`);
    return { action: 'created', id: inserted.id, name: templateName, panels: panelData.length };
  }
}

// ── Main ──
async function main() {
  console.log('🔍 Scanning R2 knowledge_files/ for wrap dimension files...\n');
  if (DRY_RUN) console.log('   ⚡ DRY RUN — no database writes\n');

  const files = await listFiles();
  console.log(`📄 Found ${files.length} files\n`);

  if (files.length === 0) {
    console.log('No files found. Check your R2 knowledge_files/ folder.');
    console.log('Filters: --prefix, --file');
    return;
  }

  let totalVehicles = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalErrors = 0;
  let fileErrors = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    console.log(`\n═══ [${i + 1}/${files.length}] ${file.fileName} (${sizeMB} MB) ═══`);

    try {
      // Claude's PDF limit is ~32MB
      if (file.size > 32 * 1024 * 1024) {
        console.log(`  ⚠ Skipping — too large (${sizeMB} MB). Max ~32MB per PDF.`);
        fileErrors++;
        continue;
      }

      // Download from R2
      console.log(`  📥 Downloading...`);
      const { buffer, contentType } = await downloadFile(file.key);
      const base64 = buffer.toString('base64');

      let mediaType = contentType;
      if (file.fileName.endsWith('.pdf')) mediaType = 'application/pdf';
      else if (file.fileName.endsWith('.png')) mediaType = 'image/png';
      else if (file.fileName.match(/\.jpe?g$/)) mediaType = 'image/jpeg';

      // Extract all vehicles from this file
      console.log(`  🤖 Sending to Claude for extraction...`);
      const result = await extractFromPDF(base64, mediaType, file.fileName);
      const vehicles = result.vehicles || [];
      console.log(`  📐 Found ${vehicles.length} vehicles in this file`);

      // Process each extracted vehicle
      for (const vehicle of vehicles) {
        const label = `${vehicle.make} ${vehicle.model} ${vehicle.variant || ''}`.trim();
        const panelCount = (vehicle.panels || []).length;

        if (DRY_RUN) {
          console.log(`    📊 ${label} (${vehicle.year_range || '?'}) — ${panelCount} panels`);
          for (const p of (vehicle.panels || [])) {
            console.log(`       ${p.label || '?'}) ${p.name}: ${p.width_in}" × ${p.height_in}" = ${p.area_sqft} sqft`);
          }
          totalVehicles++;
        } else {
          try {
            const result = await upsertTemplate(vehicle, file.fileName);
            if (result) {
              const icon = result.action === 'created' ? '✅' : '🔄';
              console.log(`    ${icon} ${result.action}: ${result.name} (${result.panels} panels)`);
              if (result.action === 'created') totalCreated++;
              else totalUpdated++;
              totalVehicles++;
            }
          } catch (err) {
            console.error(`    ❌ ${label}: ${err.message}`);
            totalErrors++;
          }
        }
      }

      // Rate limit between files (Claude rate limits)
      if (i < files.length - 1) {
        console.log(`  ⏳ Waiting 2s before next file...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      console.error(`  ❌ File error: ${err.message}`);
      fileErrors++;
    }
  }

  console.log('\n═══════════════════════════════════════════');
  console.log(`✅ Done!`);
  console.log(`   Files processed: ${files.length - fileErrors}/${files.length}`);
  console.log(`   Vehicles found: ${totalVehicles}`);
  if (!DRY_RUN) {
    console.log(`   Created: ${totalCreated}`);
    console.log(`   Updated: ${totalUpdated}`);
    console.log(`   Errors: ${totalErrors}`);
  }
  console.log('═══════════════════════════════════════════');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
