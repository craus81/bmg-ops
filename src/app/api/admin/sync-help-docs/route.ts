import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, join, basename, relative, sep } from 'path';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface ParsedDoc {
  title: string;
  category: 'help';
  content: string;
  tags: string[];
  source_path: string;
}

function walkMarkdown(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walkMarkdown(full, acc);
    else if (s.isFile() && entry.toLowerCase().endsWith('.md')) acc.push(full);
  }
  return acc;
}

function parseDoc(filePath: string, repoRoot: string): ParsedDoc {
  const raw = readFileSync(filePath, 'utf8');
  const rel = relative(repoRoot, filePath).split(sep).join('/');

  let body = raw;
  const tagsFromFrontmatter: string[] = [];
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

  let title = basename(filePath, '.md');
  for (const line of body.split('\n')) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) { title = m[1].trim(); break; }
  }

  const tags = new Set<string>(['help']);
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

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const repoRoot = process.cwd();
  const helpDir = resolve(repoRoot, 'docs/help');

  let files: string[];
  try {
    files = walkMarkdown(helpDir);
  } catch (err: any) {
    return NextResponse.json(
      { error: `Couldn't read ${helpDir}: ${err.message}` },
      { status: 500 }
    );
  }

  if (files.length === 0) {
    return NextResponse.json(
      { error: `No markdown files found in ${helpDir}` },
      { status: 500 }
    );
  }

  const docs = files.map((f) => parseDoc(f, repoRoot));

  const del = await supabase.from('knowledge_docs').delete().eq('category', 'help');
  if (del.error) {
    return NextResponse.json(
      { error: `Delete failed: ${del.error.message}` },
      { status: 500 }
    );
  }

  const rows = docs.map((d) => ({
    title: d.title,
    category: d.category,
    content: d.content,
    tags: d.tags,
    uploaded_by: auth.user.id,
  }));
  const ins = await supabase.from('knowledge_docs').insert(rows).select('id, title');
  if (ins.error) {
    return NextResponse.json(
      { error: `Insert failed: ${ins.error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    inserted: ins.data?.length || 0,
    docs: docs.map((d) => ({ title: d.title, source_path: d.source_path, tags: d.tags })),
  });
}
