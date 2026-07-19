import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { notifyMany } from '@/lib/notify';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const PostSchema = z.object({
  text: z.string().min(1).max(5000),
  sourceType: z.string().trim().min(1).max(40),
  sourceId: z.string().uuid().nullable().optional(),
  contextLabel: z.string().trim().max(200),
  contextUrl: z.string().trim().max(300),
  // Surfaces with their own tag pickers (e.g. PO notes) pass explicit IDs
  // instead of relying on @text parsing.
  userIds: z.array(z.string().uuid()).max(30).optional(),
});

/**
 * Parse @mentions out of a saved note and fan them out: a note_mentions row
 * (the Mentions inbox) + a push/in-app notification per tagged teammate.
 * Matching is server-side against approved internal profiles — "@First
 * Last" always works, "@First" works when it's unambiguous.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PostSchema);
  if (parsed.error) return parsed.error;
  const { text, sourceType, sourceId, contextLabel, contextUrl, userIds } = parsed.data;

  if (!text.includes('@') && !userIds?.length) return NextResponse.json({ mentioned: 0 });

  const { data: profiles } = await service
    .from('profiles')
    .select('id, full_name, role, roles')
    .eq('status', 'approved');
  const staff = (profiles || []).filter(p => {
    const roles: string[] = p.roles?.length ? p.roles : [p.role];
    return !roles.includes('customer');
  });

  // Tokens like "@Jessie" or "@Jessie Smith" (up to two words).
  const tokens = [...text.matchAll(/@([A-Za-z][A-Za-z'.-]*(?: [A-Za-z][A-Za-z'.-]*)?)/g)].map(m => m[1]);
  const mentionedIds = new Set<string>();
  for (const token of tokens) {
    const t = token.toLowerCase();
    // Exact full-name match first (two-word tokens), then unique first-name.
    const full = staff.filter(p => (p.full_name || '').toLowerCase() === t);
    if (full.length === 1) { mentionedIds.add(full[0].id); continue; }
    const firstWord = t.split(' ')[0];
    const firsts = staff.filter(p => (p.full_name || '').toLowerCase().split(' ')[0] === firstWord);
    if (firsts.length === 1) mentionedIds.add(firsts[0].id);
  }
  for (const id of userIds || []) {
    if (staff.some(p => p.id === id)) mentionedIds.add(id);
  }
  mentionedIds.delete(auth.user!.id); // tagging yourself is just a note

  if (mentionedIds.size === 0) return NextResponse.json({ mentioned: 0 });

  const actorName = staff.find(p => p.id === auth.user!.id)?.full_name || 'A teammate';
  const excerpt = text.length > 240 ? `${text.slice(0, 240)}…` : text;

  await service.from('note_mentions').insert(
    [...mentionedIds].map(userId => ({
      mentioned_user_id: userId,
      mentioned_by: auth.user!.id,
      source_type: sourceType,
      source_id: sourceId || null,
      context_label: contextLabel || null,
      context_url: contextUrl || null,
      note_excerpt: excerpt,
    })),
  );

  await notifyMany([...mentionedIds], {
    type: 'mention',
    title: `${actorName} mentioned you${contextLabel ? ` — ${contextLabel}` : ''}`,
    body: excerpt,
    url: contextUrl || '/home',
    channels: ['in_app', 'push'],
    forceChannels: true,
  });

  return NextResponse.json({ mentioned: mentionedIds.size });
}
