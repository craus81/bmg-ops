import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET = audit content quality (dry run)
export async function GET() {
  try {
    const { data: docs, error } = await supabase
      .from('knowledge_docs')
      .select('id, title, file_name, file_path, content')
      .order('created_at', { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    let goodContent = 0;
    let placeholderContent = 0;
    let hasFilePath = 0;
    const placeholders: { id: string; title: string; contentPreview: string }[] = [];

    for (const doc of docs!) {
      if (doc.file_path) hasFilePath++;

      const c = (doc.content || '').trim();
      const isPlaceholder =
        !c ||
        c.startsWith('[Large file:') ||
        c.startsWith('[AI') ||
        c.startsWith('[No text') ||
        c.startsWith('[Binary file') ||
        c.startsWith('[Unsupported') ||
        c.startsWith('[Content truncated') ||
        c.length < 50;

      if (isPlaceholder) {
        placeholderContent++;
        placeholders.push({
          id: doc.id,
          title: doc.title,
          contentPreview: c.substring(0, 100),
        });
      } else {
        goodContent++;
      }
    }

    return NextResponse.json({
      totalDocs: docs!.length,
      hasFilePath,
      goodContent,
      placeholderContent,
      placeholders: placeholders.slice(0, 30),
      instructions: 'POST with {"action":"clear-paths"} to null out all file_path values, or {"action":"clear-paths-and-delete-placeholders"} to also remove docs with no real content.',
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST to apply fixes
export async function POST(req: NextRequest) {
  try {
    const { action } = await req.json().catch(() => ({ action: '' }));

    if (action === 'clear-paths') {
      // Null out all file_path values so broken download links stop showing
      const { error, count } = await supabase
        .from('knowledge_docs')
        .update({ file_path: null, file_name: null, file_type: null, file_size: null })
        .not('file_path', 'is', null)
        .select('id', { count: 'exact', head: true });

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      return NextResponse.json({
        success: true,
        action: 'clear-paths',
        updatedCount: count,
        message: 'Cleared all file_path references. Knowledge base search still works using extracted content.',
      });
    }

    if (action === 'clear-paths-and-delete-placeholders') {
      // 1. Clear all file paths
      await supabase
        .from('knowledge_docs')
        .update({ file_path: null, file_name: null, file_type: null, file_size: null })
        .not('file_path', 'is', null);

      // 2. Delete docs with placeholder content
      const { data: docs } = await supabase
        .from('knowledge_docs')
        .select('id, content');

      let deleted = 0;
      for (const doc of docs || []) {
        const c = (doc.content || '').trim();
        const isPlaceholder =
          !c ||
          c.startsWith('[Large file:') ||
          c.startsWith('[AI') ||
          c.startsWith('[No text') ||
          c.startsWith('[Binary file') ||
          c.startsWith('[Unsupported') ||
          c.length < 50;

        if (isPlaceholder) {
          await supabase.from('knowledge_docs').delete().eq('id', doc.id);
          deleted++;
        }
      }

      return NextResponse.json({
        success: true,
        action: 'clear-paths-and-delete-placeholders',
        deletedCount: deleted,
        message: `Cleared file paths and deleted ${deleted} docs with placeholder content.`,
      });
    }

    return NextResponse.json({ error: 'Unknown action. Use "clear-paths" or "clear-paths-and-delete-placeholders"' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
