'use client';

/**
 * Shared @mention data layer — one source of truth for loading a user's
 * mentions, resolving who tagged them, rebuilding record deep links, and
 * marking read. Used by BOTH the MentionsInbox card (home / In-Shop /
 * graphics) and the header's Mentions popover, so the two surfaces can't
 * drift on URL rebuilding or read-state rules.
 */

import { useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { mentionSourceUrl } from '@/lib/deep-links';

export interface Mention {
  id: string;
  mentioned_by: string | null;
  source_type: string;
  source_id: string | null;
  context_label: string | null;
  context_url: string | null;
  note_excerpt: string | null;
  read_at: string | null;
  created_at: string;
}

// Mentions recorded before deep links carried bare page URLs (e.g. just
// "/tracking"), which land on the page but not the record — and rows saved
// with no context_url at all. Rebuild the canonical deep link from
// source_type + source_id (src/lib/deep-links.ts) for those; anything
// already pointing at the record is trusted as-is.
export function mentionUrl(m: Mention): string | null {
  // No stored url: the rebuilt link is the only way to land on the record.
  if (!m.context_url) return mentionSourceUrl(m.source_type, m.source_id);
  // A query string, or a bare path that embeds the record id (e.g.
  // /graphics/<id>, /installer/jobs/<id>), already deep-links — keep it.
  // CNI chat urls in particular differ by portal (admin vs installer), so
  // the stored one is more audience-correct than any rebuild.
  if (m.context_url.includes('?')) return m.context_url;
  if (m.source_id && m.context_url.includes(m.source_id)) return m.context_url;
  return mentionSourceUrl(m.source_type, m.source_id) || m.context_url;
}

export function useMentions() {
  const { user } = useAuth();
  const supabase = createClient();
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!user?.id) return;
    const { data } = await supabase
      .from('note_mentions')
      .select('id, mentioned_by, source_type, source_id, context_label, context_url, note_excerpt, read_at, created_at')
      .eq('mentioned_user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);
    const rows = (data as Mention[]) || [];
    setMentions(rows);
    const byIds = [...new Set(rows.map(m => m.mentioned_by).filter(Boolean))] as string[];
    if (byIds.length > 0) {
      const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', byIds);
      setNames(Object.fromEntries((profiles || []).map((p: any) => [p.id, p.full_name])));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [user?.id]);

  const markRead = useCallback(async (m: Mention) => {
    if (m.read_at) return;
    setMentions(prev => prev.map(x => x.id === m.id ? { ...x, read_at: new Date().toISOString() } : x));
    await supabase.from('note_mentions').update({ read_at: new Date().toISOString() }).eq('id', m.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, []);

  const markAllRead = useCallback(async () => {
    if (!user?.id) return;
    const now = new Date().toISOString();
    setMentions(prev => prev.map(x => ({ ...x, read_at: x.read_at || now })));
    await supabase.from('note_mentions').update({ read_at: now }).eq('mentioned_user_id', user.id).is('read_at', null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [user?.id]);

  const unread = mentions.filter(m => !m.read_at);

  return { mentions, unread, names, load, markRead, markAllRead };
}
