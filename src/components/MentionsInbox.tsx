'use client';

/**
 * The Mentions inbox: everything you've been tagged in, one place.
 * Self-contained and quiet — renders nothing when you have no unread
 * mentions (unless showWhenEmpty), so it mounts cheaply on home,
 * graphics, and In-Shop without adding clutter.
 *
 * Data layer lives in src/lib/use-mentions.ts, shared with the header's
 * Mentions popover — keep rendering here, behavior there.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMentions, mentionUrl } from '@/lib/use-mentions';

export default function MentionsInbox({ showWhenEmpty = false }: { showWhenEmpty?: boolean }) {
  const router = useRouter();
  const { mentions, unread, names, load, markRead, markAllRead } = useMentions();
  const [showAll, setShowAll] = useState(false);

  useEffect(() => { load(); }, [load]);

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
