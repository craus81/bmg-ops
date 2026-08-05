'use client';

/**
 * The Mentions inbox: everything you've been tagged in, one place.
 * Self-contained and quiet — renders nothing when you have no unread
 * mentions (unless showWhenEmpty), so it mounts cheaply on home,
 * graphics, and In-Shop without adding clutter.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { mentionSourceUrl } from '@/lib/deep-links';

interface Mention {
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
function mentionUrl(m: Mention): string | null {
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

export default function MentionsInbox({ showWhenEmpty = false }: { showWhenEmpty?: boolean }) {
  const router = useRouter();
  const { user } = useAuth();
  const supabase = createClient();
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);

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

  useEffect(() => { load(); }, [load]);

  const markRead = async (m: Mention) => {
    if (m.read_at) return;
    setMentions(prev => prev.map(x => x.id === m.id ? { ...x, read_at: new Date().toISOString() } : x));
    await supabase.from('note_mentions').update({ read_at: new Date().toISOString() }).eq('id', m.id);
  };

  const markAllRead = async () => {
    const now = new Date().toISOString();
    setMentions(prev => prev.map(x => ({ ...x, read_at: x.read_at || now })));
    await supabase.from('note_mentions').update({ read_at: now }).eq('mentioned_user_id', user!.id).is('read_at', null);
  };

  const unread = mentions.filter(m => !m.read_at);
  if (!showWhenEmpty && unread.length === 0) return null;

  const visible = showAll ? mentions : unread.slice(0, 5);

  return (
    <div style={{ background: 'var(--card)', border: `1px solid ${unread.length > 0 ? 'rgba(96,165,250,0.4)' : 'var(--border)'}`, borderRadius: '14px', marginBottom: '14px', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px', borderBottom: visible.length > 0 ? '1px solid var(--border)' : 'none' }}>
        <span style={{ fontSize: '12px', fontWeight: 800, color: unread.length > 0 ? '#60a5fa' : 'var(--text-muted)' }}>
          ＠ Mentions{unread.length > 0 ? ` (${unread.length})` : ''}
        </span>
        <span style={{ display: 'flex', gap: '10px' }}>
          {unread.length > 1 && (
            <button onClick={markAllRead} style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>
              mark all read
            </button>
          )}
          {mentions.length > 0 && (
            <button onClick={() => setShowAll(s => !s)} style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>
              {showAll ? 'unread only' : `history (${mentions.length})`}
            </button>
          )}
        </span>
      </div>
      {visible.length === 0 && showWhenEmpty && (
        <div style={{ padding: '14px', fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center' }}>
          No mentions — when a teammate @tags you in a note, it lands here.
        </div>
      )}
      {visible.map(m => (
        <div
          key={m.id}
          onClick={() => { markRead(m); const url = mentionUrl(m); if (url) router.push(url); }}
          style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', cursor: 'pointer', opacity: m.read_at ? 0.6 : 1 }}
        >
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
            {!m.read_at && <span style={{ color: '#60a5fa', marginRight: '5px' }}>●</span>}
            {(m.mentioned_by && names[m.mentioned_by]) || 'A teammate'}
            {m.context_label && <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}> · {m.context_label}</span>}
          </div>
          {m.note_excerpt && (
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px', whiteSpace: 'pre-wrap' }}>{m.note_excerpt}</div>
          )}
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '3px' }}>
            {new Date(m.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          </div>
        </div>
      ))}
    </div>
  );
}
