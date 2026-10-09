'use client';

/**
 * Messages → Orders: every order team chat you're in (migration 357) —
 * ones you sold, posted in, were tagged in, follow or opened — unread first.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { deepLinks } from '@/lib/deep-links';

interface OrderChatRow {
  estimateId: string;
  label: string;
  title: string | null;
  following: boolean;
  unread: number;
  lastMessage: { body: string; at: string; by: string } | null;
}

export default function OrderChatsList() {
  const router = useRouter();
  const [chats, setChats] = useState<OrderChatRow[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/order-chat', { cache: 'no-store' });
        if (!res.ok) { setError(true); return; }
        const json = await res.json();
        setChats(json.chats || []);
      } catch {
        setError(true);
      }
    })();
  }, []);

  const fmt = (iso: string) => {
    const d = new Date(iso);
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  if (error) return <div style={{ fontSize: '12px', color: '#f87171', padding: '20px 0', textAlign: 'center' }}>Could not load order chats.</div>;
  if (!chats) return <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '20px 0', textAlign: 'center' }}>Loading…</div>;
  if (chats.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-body)', marginBottom: '4px' }}>No order chats yet</div>
        <div style={{ fontSize: '12px', color: 'var(--text-label)' }}>Open an estimate or SO and use its Team chat to talk about the order.</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {chats.map(c => (
        <button
          key={c.estimateId}
          onClick={() => router.push(deepLinks.orderChat(c.estimateId))}
          style={{
            display: 'flex', alignItems: 'center', gap: '10px', padding: '12px', borderRadius: '12px',
            background: c.unread > 0 ? 'rgba(59,130,246,0.06)' : 'var(--subtle-bg)',
            border: `1px solid ${c.unread > 0 ? 'rgba(59,130,246,0.2)' : 'var(--border)'}`,
            cursor: 'pointer', textAlign: 'left', width: '100%',
          }}
        >
          <div style={{
            width: '40px', height: '40px', borderRadius: '50%', flexShrink: 0, fontSize: '18px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(96,165,250,0.12)', border: '2px solid rgba(96,165,250,0.3)',
          }}>💬</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
              <div style={{ fontSize: '13px', fontWeight: c.unread > 0 ? 800 : 600, color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.label}
              </div>
              {c.lastMessage && <div style={{ fontSize: '10px', color: 'var(--text-label)', flexShrink: 0 }}>{fmt(c.lastMessage.at)}</div>}
            </div>
            <div style={{
              fontSize: '11px', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              color: c.unread > 0 ? 'var(--text-body)' : 'var(--text-label)', fontWeight: c.unread > 0 ? 600 : 400,
            }}>
              {c.lastMessage ? `${c.lastMessage.by}: ${c.lastMessage.body}` : ''}
              {!c.following && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · not following</span>}
            </div>
          </div>
          {c.unread > 0 && (
            <div style={{
              minWidth: '20px', height: '20px', borderRadius: '10px', background: '#3b82f6', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: 800, padding: '0 5px', flexShrink: 0,
            }}>{c.unread}</div>
          )}
        </button>
      ))}
    </div>
  );
}
