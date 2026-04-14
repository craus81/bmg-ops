#!/usr/bin/env node
/**
 * Extract vehicle wrap dimensions from PDFs in R2 knowledge_files folder.
 *
 * Processes PDFs PAGE-BY-PAGE to avoid truncation issues.
 * Each page typically has 1 vehicle with its dimension table.
 *
 * Usage:
 *   node scripts/extract-dimensions.mjs                    # Process all files
 *   node scripts/extract-dimensions.mjs --dry-run          # Preview without writing to DB
 *   node scripts/extract-dimensions.mjs --fix-empty        # Only re-process vehicles with empty panel_data
 *   node scripts/extract-dimensions.mjs --prefix "Ford"    # Only process files matching prefix
 *   node scripts/extract-dimensions.mjs --file "pages_1-10"  # Process single file
 *
 * Required env vars (in .env.local):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *   ANTHROPIC_API_KEY
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config(); // also load .env as fallback
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument } from 'pdf-lib';

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
const FIX_EMPTY = args.includes('--fix-empty');
const PREFIX_FILTER = args.includes('--prefix') ? args[args.indexOf('--prefix') + 1] : null;
const SINGLE_FILE = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Claude extraction prompt for a SINGLE PAGE ──
const EXTRACTION_PROMPT = `You are analyzing a SINGLE PAGE from a vehicle wrap dimension sheet. This page shows ONE vehicle (possibly with variants) from multiple angles (driver side, passenger side, front, rear, top/roof) with a dimension table.

Extract the following:

1. VEHICLE INFO:
   - make (e.g., "Chevrolet", "Ford", "Mercedes-Benz", "RAM", "GMC")
   - model (e.g., "Express", "Transit", "Sprinter", "ProMaster")
   - year_range (e.g., "2003-Present", "2015-2023")
   - variant (e.g., "Short Wheelbase", "Long Wheelbase", "High Roof", "Extended", "Crew Cab") or null
   - overall_length_in: overall vehicle length in inches
   - overall_height_in: overall height in inches
   - wheelbase_in: wheelbase in inches

2. PANEL DIMENSIONS (from the dimension table, usually labeled A through H or more):
   - name: descriptive name ("Driver Side", "Passenger Side", "Rear", "Hood/Front", "Roof", etc.)
   - label: the letter label (A, B, C, etc.)
   - width_in: width in inches
   - height_in: height in inches
   - area_sqft: total square feet (from the table, or calculate: width_in × height_in / 144)

Return ONLY valid JSON, no markdown, no backticks:
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
      ]
    }
  ]
}

CRITICAL RULES:
- If this page has MULTIPLE variants (e.g., short vs long wheelbase), list each as a separate vehicle entry
- Dimensions must be in INCHES (convert from mm if needed: mm ÷ 25.4 = inches)
- Skip panels listed as "N/A"
- Include window film panels separately with "(Window Film)" in the name
- If the page doesn't contain any vehicle dimension data, return: {"vehicles": []}
- Extract ALL panels from the dimension table — do not skip any`;

// ── List R2 files ──
async function listFiles() {
  const prefix = 'knowledge-files/uploads/';
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

      if (/\.pdf$/i.test(fileName)) {
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
  return Buffer.concat(chunks);
}

// ── Split PDF into individual pages ──
async function splitPDF(pdfBuffer) {
  const srcDoc = await PDFDocument.load(pdfBuffer);
  const pageCount = srcDoc.getPageCount();
  const pages = [];

  for (let i = 0; i < pageCount; i++) {
    const newDoc = await PDFDocument.create();
    const [copiedPage] = await newDoc.copyPages(srcDoc, [i]);
    newDoc.addPage(copiedPage);
    const bytes = await newDoc.save();
    pages.push({
      pageNum: i + 1,
      buffer: Buffer.from(bytes),
    });
  }

  return { pages, totalPages: pageCount };
}

// ── Send single page to Claude ──
async function extractFromPage(base64Data, fileName, pageNum) {
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
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: base64Data,
            },
          },
          {
            type: 'text',
            text: `${EXTRACTION_PROMPT}\n\nSource: ${fileName}, page ${pageNum}`,
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

  // Parse JSON
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in Claude response');

  const parsed = JSON.parse(jsonMatch[0]);
  return parsed;
}

// ── Upload a single-page PDF to R2 as the template preview image ──
async function uploadPagePreview(pageBuffer, make, model, variant, year) {
  const slug = [make, model, variant, year].filter(Boolean).join('-')
    .toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  const key = `vehicle-templates/previews/${slug}.pdf`;

  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: pageBuffer,
    ContentType: 'application/pdf',
  }));

  // Return the path relative to the bucket (what Supabase storage.getPublicUrl expects)
  return `previews/${slug}.pdf`;
}

// ── Upsert one vehicle into vehicle_templates ──
async function upsertTemplate(vehicle, sourceFile, pageBuffer) {
  const { make, model, year_range, variant, overall_length_in, overall_height_in, wheelbase_in, panels } = vehicle;

  if (!make || !model) {
    console.warn(`      ⚠ Skipping — no make/model extracted`);
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

  if (panelData.length === 0) {
    console.warn(`      ⚠ Skipping — no panel dimensions extracted`);
    return null;
  }

  // Parse year from year_range
  const yearMatch = year_range?.match(/(\d{4})/);
  const year = yearMatch ? yearMatch[1] : null;

  const templateName = [make, model, variant, year_range].filter(Boolean).join(' ');

  // Check for existing template (make + model + variant)
  let query = supabase
    .from('vehicle_templates')
    .select('id, panel_data')
    .ilike('make', make)
    .ilike('model', model);

  if (variant) {
    query = query.ilike('variant', `%${variant}%`);
  } else {
    query = query.or('variant.is.null,variant.eq.');
  }

  const { data: existing } = await query.limit(1);

  // In --fix-empty mode, skip vehicles that already have VALID panel_data
  if (FIX_EMPTY && existing?.length > 0) {
    const existingPanels = existing[0].panel_data;
    // Only skip if panels exist AND have actual non-zero dimensions
    const hasValidPanels = Array.isArray(existingPanels) && existingPanels.length > 0 &&
      existingPanels.some(p => p.width_in > 0 && p.height_in > 0);
    if (hasValidPanels) {
      return { action: 'skipped', id: existing[0].id, name: templateName, panels: existingPanels.length };
    }
  }

  // Upload the PDF page as the template preview image
  let templateImagePath = null;
  if (pageBuffer) {
    try {
      templateImagePath = await uploadPagePreview(pageBuffer, make, model, variant, year);
      console.log(`      📸 Uploaded preview: ${templateImagePath}`);
    } catch (err) {
      console.warn(`      ⚠ Failed to upload preview: ${err.message}`);
    }
  }

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
    template_image_path: templateImagePath,
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
  console.log('🔍 Scanning R2 for wrap dimension PDFs...\n');
  if (DRY_RUN) console.log('   ⚡ DRY RUN — no database writes\n');
  if (FIX_EMPTY) console.log('   🔧 FIX-EMPTY mode — only updating vehicles with missing panel_data\n');

  const files = await listFiles();
  console.log(`📄 Found ${files.length} PDF files\n`);

  if (files.length === 0) {
    console.log('No files found. Check your R2 knowledge-files/uploads/ folder.');
    console.log('Filters: --prefix, --file');
    return;
  }

  let totalVehicles = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let totalPages = 0;
  let fileErrors = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    console.log(`\n═══ [${i + 1}/${files.length}] ${file.fileName} (${sizeMB} MB) ═══`);

    try {
      // Download from R2
      console.log(`  📥 Downloading...`);
      const pdfBuffer = await downloadFile(file.key);

      // Split into individual pages
      console.log(`  📄 Splitting PDF into pages...`);
      const { pages, totalPages: pageCount } = await splitPDF(pdfBuffer);
      console.log(`  📄 ${pageCount} pages found`);
      totalPages += pageCount;

      // Process each page individually
      for (const page of pages) {
        console.log(`\n    ── Page ${page.pageNum}/${pageCount} ──`);
        const base64 = page.buffer.toString('base64');

        try {
          console.log(`    🤖 Extracting...`);
          const result = await extractFromPage(base64, file.fileName, page.pageNum);
          const vehicles = result.vehicles || [];

          if (vehicles.length === 0) {
            console.log(`    📭 No vehicles on this page`);
            continue;
          }

          for (const vehicle of vehicles) {
            const label = `${vehicle.make} ${vehicle.model} ${vehicle.variant || ''}`.trim();
            const panelCount = (vehicle.panels || []).length;

            if (DRY_RUN) {
              console.log(`      📊 ${label} (${vehicle.year_range || '?'}) — ${panelCount} panels`);
              for (const p of (vehicle.panels || [])) {
                console.log(`         ${p.label || '?'}) ${p.name}: ${p.width_in}" × ${p.height_in}" = ${p.area_sqft} sqft`);
              }
              totalVehicles++;
            } else {
              try {
                const result = await upsertTemplate(vehicle, file.fileName, page.buffer);
                if (result) {
                  if (result.action === 'skipped') {
                    console.log(`      ⏭ skipped: ${result.name} (already has ${result.panels} panels)`);
                    totalSkipped++;
                  } else {
                    const icon = result.action === 'created' ? '✅' : '🔄';
                    console.log(`      ${icon} ${result.action}: ${result.name} (${result.panels} panels)`);
                    if (result.action === 'created') totalCreated++;
                    else totalUpdated++;
                  }
                  totalVehicles++;
                }
              } catch (err) {
                console.error(`      ❌ ${label}: ${err.message}`);
                totalErrors++;
              }
            }
          }

          // Rate limit between pages (1s between pages, less aggressive than between files)
          await new Promise(r => setTimeout(r, 1000));

        } catch (err) {
          console.error(`    ❌ Page ${page.pageNum} error: ${err.message}`);
          totalErrors++;
          // Continue to next page
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      // Extra pause between files
      if (i < files.length - 1) {
        console.log(`\n  ⏳ Waiting 2s before next file...`);
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
  console.log(`   Pages processed: ${totalPages}`);
  console.log(`   Vehicles found: ${totalVehicles}`);
  if (!DRY_RUN) {
    console.log(`   Created: ${totalCreated}`);
    console.log(`   Updated: ${totalUpdated}`);
    if (FIX_EMPTY) console.log(`   Skipped (already had data): ${totalSkipped}`);
    console.log(`   Errors: ${totalErrors}`);
  }
  console.log('═══════════════════════════════════════════');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
