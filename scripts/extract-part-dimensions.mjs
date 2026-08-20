#!/usr/bin/env node
/**
 * Extract part dimensions (W×D×H, weight) for the 3D upfit designer
 * (migration 213) from vendor product pages the catalog already links.
 *
 * The vendor-asset importer harvests dims deterministically (JSON-LD, spec
 * text) at import time; this script is the mop-up for pages it couldn't
 * read — Claude extracts the numbers from the page text, or from a linked
 * spec PDF when the page itself carries none. Writes are fill-blank only
 * (parts whose width_in is NULL) and stamped dims_source='pdf_vision', so
 * a manual entry or a re-run never gets clobbered.
 *
 * Usage:
 *   node scripts/extract-part-dimensions.mjs                  # up to 50 parts
 *   node scripts/extract-part-dimensions.mjs --dry-run        # no DB writes
 *   node scripts/extract-part-dimensions.mjs --vendor Ranger  # one vendor
 *   node scripts/extract-part-dimensions.mjs --item F5-RA48   # one part
 *   node scripts/extract-part-dimensions.mjs --limit 200
 *
 * Required env vars (in .env.local):
 *   ANTHROPIC_API_KEY
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config(); // also load .env as fallback
import { createClient } from '@supabase/supabase-js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
const VENDOR = args.includes('--vendor') ? args[args.indexOf('--vendor') + 1] : null;
const ITEM = args.includes('--item') ? args[args.indexOf('--item') + 1] : null;
const LIMIT = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) || 50 : 50;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Same browser-standard headers as the vendor-asset importer — several
// vendor sites 403 anything that doesn't look like a browser.
const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

const EXTRACTION_PROMPT = `You are reading a van-equipment vendor's product page (shelving units, drawer cabinets, bins, partitions, ladder racks and similar) to record the product's INSTALLED physical dimensions.

Extract, in INCHES (convert from cm/mm if needed) and POUNDS:
- width_in: left-right footprint along the mounting wall
- depth_in: how far the product sticks out into the cargo area
- height_in: vertical height
- weight_lb: shipping or product weight, if stated

Rules:
- Only report numbers the page actually states for THIS product. If a dimension is not stated, use null.
- If the page lists several size variants and the part number in context matches one, use that variant; otherwise use null for everything.
- Return ONLY valid JSON, no markdown, no backticks:
{"width_in": 52, "depth_in": 14, "height_in": 46, "weight_lb": 78}`;

const sane = (n, lo, hi) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;

async function fetchPage(url, maxBytes = 2_000_000) {
  const res = await fetch(url, {
    headers: { ...FETCH_HEADERS, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(15_000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`Response too large (${buf.length} bytes)`);
  return buf;
}

const stripHtml = (html) => html
  .replace(/<(script|style|header|nav|footer)\b[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** A spec-sheet PDF linked from the page, if any — the fallback document. */
function findSpecPdfUrl(html, pageUrl) {
  for (const m of html.matchAll(/href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/gi)) {
    try {
      const u = new URL(m[1], pageUrl).toString();
      if (/spec|dimension|cut.?sheet|data.?sheet|install/i.test(u)) return u;
    } catch { /* unparseable href */ }
  }
  return null;
}

/** One Claude call: page text (and optionally a PDF) → dimension JSON. */
async function extractWithClaude(content, itemNumber) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: 1024,
      // Mechanical extraction — low effort keeps it fast and cheap.
      output_config: { effort: 'low' },
      fallbacks: 'default',
      messages: [{
        role: 'user',
        content: [
          ...content,
          { type: 'text', text: `${EXTRACTION_PROMPT}\n\nThe part number in context is: ${itemNumber}` },
        ],
      }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API error ${res.status}: ${errText.substring(0, 300)}`);
  }
  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('Claude declined the request');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in Claude response');
  return JSON.parse(jsonMatch[0]);
}

async function main() {
  console.log('🔍 Finding parts with a product page but no dimensions...\n');
  if (DRY_RUN) console.log('   ⚡ DRY RUN — no database writes\n');

  // Paged walk per the 1000-row rule; stop once LIMIT candidates are in hand.
  const candidates = [];
  for (let from = 0; candidates.length < LIMIT; from += 1000) {
    let query = supabase
      .from('netsuite_parts')
      .select('id, item_number, display_name, vendor, product_url')
      .eq('is_active', true)
      .not('product_url', 'is', null)
      .is('width_in', null)
      .order('item_number')
      .order('id')
      .range(from, from + 999);
    if (VENDOR) query = query.ilike('vendor', `%${VENDOR}%`);
    if (ITEM) query = query.ilike('item_number', `%${ITEM}%`);
    const { data: rows, error } = await query;
    if (error) {
      console.error('❌ Parts read failed:', error.message);
      process.exit(1);
    }
    candidates.push(...(rows || []));
    if (!rows || rows.length < 1000) break;
  }
  const parts = candidates.slice(0, LIMIT);
  console.log(`📄 ${parts.length} part(s) to process (limit ${LIMIT})\n`);

  let saved = 0;
  let noDims = 0;
  let errors = 0;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    console.log(`\n═══ [${i + 1}/${parts.length}] ${p.item_number} — ${p.display_name || ''} ═══`);
    console.log(`  🌐 ${p.product_url}`);
    try {
      const pageBuf = await fetchPage(p.product_url);
      const html = pageBuf.toString('utf8');
      const text = stripHtml(html).slice(0, 30_000);

      let dims = await extractWithClaude([{ type: 'text', text: `PRODUCT PAGE TEXT:\n${text}` }], p.item_number);

      // Page said nothing → try a linked spec-sheet PDF, if the page has one.
      const complete = d => sane(d?.width_in, 0.5, 300) && sane(d?.depth_in, 0.5, 300) && sane(d?.height_in, 0.5, 300);
      if (!complete(dims)) {
        const pdfUrl = findSpecPdfUrl(html, p.product_url);
        if (pdfUrl) {
          console.log(`  📎 Trying spec PDF: ${pdfUrl}`);
          try {
            const pdfBuf = await fetchPage(pdfUrl, 8_000_000);
            dims = await extractWithClaude([{
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfBuf.toString('base64') },
            }], p.item_number);
          } catch (err) {
            console.log(`  ⚠ Spec PDF failed: ${err.message}`);
          }
        }
      }

      if (!complete(dims)) {
        console.log('  📭 No complete W×D×H on this page');
        noDims++;
      } else {
        const weight = sane(dims.weight_lb, 0.1, 2000) ? dims.weight_lb : null;
        console.log(`  📐 ${dims.width_in}"W × ${dims.depth_in}"D × ${dims.height_in}"H${weight ? ` · ${weight} lb` : ''}`);
        if (DRY_RUN) {
          saved++;
        } else {
          // Guard the fill-blank rule at write time too — someone may have
          // typed dims while this script was running.
          const { data: updated, error } = await supabase
            .from('netsuite_parts')
            .update({
              width_in: dims.width_in, depth_in: dims.depth_in, height_in: dims.height_in,
              weight_lb: weight, dims_source: 'pdf_vision',
            })
            .eq('id', p.id)
            .is('width_in', null)
            .select('id');
          if (error) throw new Error(error.message);
          if (updated && updated.length > 0) {
            console.log('  ✅ Saved');
            saved++;
          } else {
            console.log('  ⏭ Skipped — dims appeared while the script ran');
          }
        }
      }
    } catch (err) {
      console.error(`  ❌ ${err.message}`);
      errors++;
    }
    // Polite pacing toward the vendor site (and the API).
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('\n═══════════════════════════════════════════');
  console.log(`✅ Done!${DRY_RUN ? ' (dry run)' : ''}`);
  console.log(`   Dims ${DRY_RUN ? 'found' : 'saved'}: ${saved}`);
  console.log(`   No dims on page: ${noDims}`);
  console.log(`   Errors: ${errors}`);
  console.log('═══════════════════════════════════════════');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
