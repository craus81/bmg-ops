'use client';

/**
 * An order's team chat (migration 357): one running conversation per
 * estimate, which carries over when it becomes a sales order. Mounted on
 * the estimate builder, the In-Shop vehicle card (for linked estimates) and
 * its own page, /order-chat/<estimate id>, which every internal role can
 * open. All reads and writes go through /api/order-chat; the realtime
 * subscription only tells an open chat that something new arrived.
 *
 * Posting pings the rep and everyone following (push + in-app, no email);
 * @tagged teammates get the usual mention via reportMentions.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import MentionTextArea, { reportMentions } from '@/components/MentionTextArea';
import { deepLinks } from '@/lib/deep-links';
import { flashNote } from '@/lib/focus-note';

interface ChatMessage { id: string; user_id: string | null; body: string; created_at: string }

interface ChatState {
  estimate: { id: string; label: string; title: string | null; created_by: string | null; fleet_checkin_id: string | null; status: string | null };
  messages: ChatMessage[];
  names: Record<string, string>;
  followers: string[];
  following: boolean;
  isRep: boolean;
  truncated: boolean;
}

export default function OrderTeamChat({
  estimateId,
  variant = 'embedded',
  flashMessageId,
  onLoaded,
}: {
  estimateId: string;
  /** 'embedded' sits inside another record's screen with a capped height;
   *  'page' is the standalone chat page. */
  variant?: 'embedded' | 'page';
  flashMessageId?: string | null;
  onLoaded?: (s: { label: string; fleetCheckinId: string | null; title: string | null }) => void;
}) {
  const { user } = useAuth();
  const dialog = useDialog();
  const supabase = createClient();
  const [state, setState] = useState<ChatState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const flashedRef = useRef(false);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/order-chat/${estimateId}`, { cache: 'no-store' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error || 'Could not load the team chat'); return; }
      setState(json as ChatState);
      setError(null);
      onLoadedRef.current?.({ label: json.estimate.label, fleetCheckinId: json.estimate.fleet_checkin_id, title: json.estimate.title });
    } catch {
      setError('Could not load the team chat');
    }
  }, [estimateId]);

  useEffect(() => { setState(null); flashedRef.current = false; load(); }, [load]);

  // Someone else posted: reload (it also marks the chat read, since it's open).
  useEffect(() => {
    const channel = supabase
      .channel(`order-chat-${estimateId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'order_chat_messages', filter: `estimate_id=eq.${estimateId}` },
        (payload: any) => {
          if (payload.new?.user_id !== user?.id) load();
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [estimateId, user?.id, load]);

  // Keep the newest message in view; a deep link flashes its message once.
  useEffect(() => {
    if (!state) return;
    if (flashMessageId && !flashedRef.current && state.messages.some(m => m.id === flashMessageId)) {
      flashedRef.current = true;
      flashNote(`ocm-${flashMessageId}`);
      return;
    }
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state, flashMessageId]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending || !state) return;
    setSending(true);
    try {
      const res = await fetch(`/api/order-chat/${estimateId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { await dialog.alert(json.error || 'Could not send'); return; }
      setDraft('');
      reportMentions({
        text: body,
        sourceType: 'order_chat',
        sourceId: estimateId,
        contextLabel: `${json.label || state.estimate.label} team chat`,
        contextUrl: deepLinks.orderChat(estimateId, json.message?.id),
      });
      await load();
    } finally {
      setSending(false);
    }
  };

  const toggleFollow = async () => {
    if (!state) return;
    const next = !state.following;
    const res = await fetch(`/api/order-chat/${estimateId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ following: next }),
    });
    if (res.ok) load();
  };

  const remove = async (m: ChatMessage) => {
    if (!(await dialog.confirm('Delete this message?', { destructive: true, confirmLabel: 'Delete' }))) return;
    const res = await fetch(`/api/order-chat/${estimateId}?message=${m.id}`, { method: 'DELETE' });
    if (res.ok) setState(s => (s ? { ...s, messages: s.messages.filter(x => x.id !== m.id) } : s));
  };

  const followerNames = state
    ? state.followers.map(id => (id === user?.id ? 'you' : (state.names[id] || 'Teammate').split(' ')[0]))
    : [];

  const fmt = (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  const boxStyle: React.CSSProperties = {
    background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden',
  };

  return (
    <div id={`order-chat-${estimateId}`} style={boxStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: '12px', fontWeight: 800, color: '#60a5fa' }}>💬 Team chat</span>
        {state && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
            {followerNames.length ? `Pinging ${followerNames.join(', ')}` : 'Nobody following yet'}
          </span>
        )}
        {!state && <span style={{ flex: 1 }} />}
        {state && (
          <button
            type="button"
            onClick={toggleFollow}
            title={state.following ? 'Stop getting pinged about this order' : 'Get pinged when someone posts here'}
            style={{
              padding: '4px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', flexShrink: 0,
              border: `1px solid ${state.following ? 'var(--border)' : 'rgba(96,165,250,0.5)'}`,
              background: state.following ? 'transparent' : 'rgba(96,165,250,0.12)',
              color: state.following ? 'var(--text-secondary)' : '#60a5fa',
            }}
          >
            {state.following ? 'Following ✓' : 'Follow'}
          </button>
        )}
      </div>

      <div
        ref={listRef}
        style={{
          padding: '10px 12px', overflowY: 'auto',
          maxHeight: variant === 'page' ? 'calc(60vh / var(--ts))' : '280px',
          minHeight: variant === 'page' ? '160px' : undefined,
        }}
      >
        {error && <div style={{ fontSize: '12px', color: '#f87171' }}>{error}</div>}
        {!state && !error && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</div>}
        {state && state.truncated && (
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', textAlign: 'center', marginBottom: '8px' }}>Showing the latest messages</div>
        )}
        {state && state.messages.length === 0 && (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', padding: '8px 0' }}>
            No messages yet. Ask a question or give an update about this order. Type @ to tag someone.
          </div>
        )}
        {state?.messages.map(m => {
          const mine = m.user_id === user?.id;
          return (
            <div key={m.id} id={`ocm-${m.id}`} style={{ marginBottom: '10px', borderRadius: '8px', padding: '2px 4px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                <span style={{ fontSize: '12px', fontWeight: 800, color: mine ? '#60a5fa' : 'var(--text-primary)' }}>
                  {mine ? 'You' : (m.user_id ? state.names[m.user_id] || 'Teammate' : 'Former teammate')}
                </span>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{fmt(m.created_at)}</span>
                {mine && (
                  <button
                    type="button"
                    onClick={() => remove(m)}
                    title="Delete your message"
                    style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '11px', cursor: 'pointer', padding: 0 }}
                  >✕</button>
                )}
              </div>
              <div style={{ fontSize: '13px', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', lineHeight: 1.45, wordBreak: 'break-word' }}>{m.body}</div>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', padding: '10px 12px', borderTop: '1px solid var(--border)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <MentionTextArea
            value={draft}
            onChange={setDraft}
            placeholder="Message the team about this order (@ tags someone)"
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            style={{
              width: '100%', padding: '9px 10px', borderRadius: '8px', border: '1px solid var(--border)',
              background: 'var(--input-bg, var(--bg))', color: 'var(--text-primary)', fontSize: '16px',
              fontFamily: 'inherit', resize: 'none', boxSizing: 'border-box',
            }}
          />
        </div>
        <button
          type="button"
          onClick={send}
          disabled={!draft.trim() || sending || !state}
          style={{
            padding: '9px 14px', borderRadius: '8px', border: 'none', background: '#3b82f6', color: '#fff',
            fontWeight: 800, fontSize: '13px', cursor: draft.trim() && !sending ? 'pointer' : 'default',
            opacity: draft.trim() && !sending && state ? 1 : 0.5, flexShrink: 0,
          }}
        >
          {sending ? '…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
