#!/usr/bin/env node

/**
 * Sync every docs/help/<role>.md file (recursive) into knowledge_docs.
 *
 * The markdown files in docs/help/ are the source of truth for the in-app
 * help library. Run this script after editing them to push the latest content
 * into Supabase so the FleetSuite AI assistant and the Admin → Knowledge
 * search box pick up the changes.
 *
 * Behavior:
 *   - Title is the first H1 line (the leading "# ...") of the file.
 *     If no H1 is present, falls back to the filename.
 *   - Content is the entire file contents (markdown source).
 *   - Category is 'help'.
 *   - Tags include 'help', the file basename, and any role keywords inferred
 *     from the path (admin, sales, installer, etc.) — plus any explicit tags
 *     in a "tags:" frontmatter line at the top of the file (optional).
 *   - The script DELETEs every existing row with category='help' and then
 *     inserts fresh rows. This keeps the table consistent with the markdown
 *     and avoids drift from edits made directly in the admin/knowledge UI.
 *
 * Usage:
 *   node scripts/sync-help-docs.mjs
 *
 * Options:
 *   --dry-run     Print what would change without touching the database.
 *
 * Required env (loaded from .env.local if present):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join, basename, relative, sep } from 'path';

function loadEnv() {
  try {
    const envPath = resolve(process.cwd(), '.env.local');
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // .env.local missing is fine — env vars may be set elsewhere
  }
}

function walkMarkdown(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walkMarkdown(full, acc);
    else if (s.isFile() && entry.toLowerCase().endsWith('.md')) acc.push(full);
  }
  return acc;
}

function parseDoc(filePath, repoRoot) {
  const raw = readFileSync(filePath, 'utf8');
  const rel = relative(repoRoot, filePath).split(sep).join('/');

  // Optional frontmatter-lite: if the file starts with "---", parse simple key: value lines.
  let body = raw;
  const tagsFromFrontmatter = [];
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end > 0) {
      const fm = raw.slice(3, end).trim();
      body = raw.slice(end + 4).replace(/^\n/, '');
      for (const line of fm.split('\n')) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const k = line.slice(0, colon).trim();
        const v = line.slice(colon + 1).trim();
        if (k.toLowerCase() === 'tags') {
          for (const t of v.split(',')) {
            const trimmed = t.trim();
            if (trimmed) tagsFromFrontmatter.push(trimmed);
          }
        }
      }
    }
  }

  // Title = first H1 line, fallback to filename.
  let title = basename(filePath, '.md');
  for (const line of body.split('\n')) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) { title = m[1].trim(); break; }
  }

  // Tags: 'help', file basename, role keywords from path, plus frontmatter.
  const tags = new Set(['help']);
  tags.add(basename(filePath, '.md'));
  const roleKeywords = ['admin', 'sales', 'installer', 'graphics-production', 'shop-and-field-tech', 'customer', 'getting-started', 'glossary', 'workflows'];
  for (const part of rel.toLowerCase().split('/')) {
    for (const kw of roleKeywords) {
      if (part.includes(kw)) tags.add(kw);
    }
  }
  for (const t of tagsFromFrontmatter) tags.add(t);

  return {
    title,
    category: 'help',
    content: raw,
    tags: Array.from(tags),
    source_path: rel,
  };
}

async function main() {
  loadEnv();

  const dryRun = process.argv.includes('--dry-run');
  const repoRoot = process.cwd();
  const helpDir = resolve(repoRoot, 'docs/help');

  let files;
  try {
    files = walkMarkdown(helpDir);
  } catch (err) {
    console.error(`Couldn't read ${helpDir}: ${err.message}`);
    process.exit(1);
  }

  if (files.length === 0) {
    console.error(`No markdown files found in ${helpDir}`);
    process.exit(1);
  }

  const docs = files.map((f) => parseDoc(f, repoRoot));

  console.log(`Found ${docs.length} help documents:`);
  for (const d of docs) {
    console.log(`  - ${d.source_path}  →  "${d.title}"  [${d.tags.join(', ')}]`);
  }

  if (dryRun) {
    console.log('\n--dry-run set, exiting without touching the database.');
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.');
    process.exit(1);
  }
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

  console.log(`\nDeleting existing category='help' rows...`);
  const del = await supabase.from('knowledge_docs').delete().eq('category', 'help');
  if (del.error) {
    console.error(`Delete failed: ${del.error.message}`);
    process.exit(1);
  }

  console.log(`Inserting ${docs.length} fresh rows...`);
  const rows = docs.map((d) => ({
    title: d.title,
    category: d.category,
    content: d.content,
    tags: d.tags,
  }));
  const ins = await supabase.from('knowledge_docs').insert(rows).select('id, title');
  if (ins.error) {
    console.error(`Insert failed: ${ins.error.message}`);
    process.exit(1);
  }

  console.log(`Inserted ${ins.data.length} rows.`);
  console.log('Done. The FleetSuite AI and Admin → Knowledge search will pick up the new content immediately.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
