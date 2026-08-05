import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { notifyMany } from '@/lib/notify';
import { mentionSourceUrl } from '@/lib/deep-links';

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
  // Single-column notes (estimate internal notes, graphics job notes) send
  // the note's previous value on edit: anyone already @mentioned there was
  // notified last time and is skipped, so re-saving doesn't re-ping them.
  previousText: z.string().max(5000).optional(),
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
  const { text, sourceType, sourceId, contextLabel, contextUrl, userIds, previousText } = parsed.data;

  if (!text.includes('@') && !userIds?.length) return NextResponse.json({ mentioned: 0 });

  const { data: profiles } = await service
    .from('profiles')
    .select('id, full_name, role, roles')
    .eq('status', 'approved');
  const staff = (profiles || []).filter(p => {
    const roles: string[] = p.roles?.length ? p.roles : [p.role];
    // Only customer-ONLY accounts are un-mentionable; a multi-role account
    // (e.g. admin + customer) is still staff — same semantics as
    // /api/scans/log and /api/parts.
    return !(roles.includes('customer') && roles.length === 1);
  });

  // Resolve "@Jessie" / "@Jessie Smith" tokens (up to two words) to profile
  // ids: exact full-name match first, then unique first-name.
  const resolveMentions = (body: string): Set<string> => {
    const tokens = [...body.matchAll(/@([A-Za-z][A-Za-z'.-]*(?: [A-Za-z][A-Za-z'.-]*)?)/g)].map(m => m[1]);
    const ids = new Set<string>();
    for (const token of tokens) {
      const t = token.toLowerCase();
      const full = staff.filter(p => (p.full_name || '').toLowerCase() === t);
      if (full.length === 1) { ids.add(full[0].id); continue; }
      const firstWord = t.split(' ')[0];
      const firsts = staff.filter(p => (p.full_name || '').toLowerCase().split(' ')[0] === firstWord);
      if (firsts.length === 1) ids.add(firsts[0].id);
    }
    return ids;
  };

  const mentionedIds = resolveMentions(text);
  for (const id of userIds || []) {
    if (staff.some(p => p.id === id)) mentionedIds.add(id);
  }
  // Edited single-column note: whoever was mentioned in the previous version
  // already got notified — only ping people added this save.
  if (previousText) {
    for (const id of resolveMentions(previousText)) mentionedIds.delete(id);
  }
  mentionedIds.delete(auth.user!.id); // tagging yourself is just a note

  if (mentionedIds.size === 0) return NextResponse.json({ mentioned: 0 });

  const actorName = staff.find(p => p.id === auth.user!.id)?.full_name || 'A teammate';
  const excerpt = text.length > 240 ? `${text.slice(0, 240)}…` : text;

  // A mention must land ON the note's record: trust the surface's contextUrl,
  // else derive the canonical deep link from the source entity server-side —
  // '/home' is the last resort only when neither identifies the record.
  const deepUrl = contextUrl || mentionSourceUrl(sourceType, sourceId) || null;

  await service.from('note_mentions').insert(
    [...mentionedIds].map(userId => ({
      mentioned_user_id: userId,
      mentioned_by: auth.user!.id,
      source_type: sourceType,
      source_id: sourceId || null,
      context_label: contextLabel || null,
      context_url: deepUrl,
      note_excerpt: excerpt,
    })),
  );

  await notifyMany([...mentionedIds], {
    type: 'mention',
    title: `${actorName} mentioned you${contextLabel ? ` — ${contextLabel}` : ''}`,
    body: excerpt,
    url: deepUrl || '/home',
    channels: ['in_app', 'push'],
    forceChannels: true,
  });

  return NextResponse.json({ mentioned: mentionedIds.size });
}
