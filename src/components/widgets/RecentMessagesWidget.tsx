'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function RecentMessagesWidget() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<any[]>([]);

  useEffect(() => { load(); }, []);

  const load = async () => {
    const { data } = await supabase
      .from('messages')
      .select('id, body, sender_name, created_at, conversation_id, is_sms')
      .order('created_at', { ascending: false })
      .limit(6);

    setMessages(data || []);
    setLoading(false);
  };

  const timeAgo = (d: string) => {
    const diff = Date.now() - new Date(d).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  };

  return (
    <WidgetShell title="Recent Messages" icon="" loading={loading} onHeaderClick={() => router.push('/messages')}>
      {messages.length === 0 ? (
        <div style={{ textAlign: 'center', color: theme.textMuted, fontSize: '12px', padding: '16px 0' }}>No messages yet</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {messages.map(m => (
            <button key={m.id} onClick={() => router.push('/messages')} style={{
              display: 'flex', gap: '8px', alignItems: 'start', width: '100%',
              padding: '6px 8px', borderRadius: '6px', border: 'none', textAlign: 'left',
              background: 'var(--subtle-bg)', cursor: 'pointer',
            }}>
              <div style={{
                width: '28px', height: '28px', borderRadius: '50%', flexShrink: 0,
                background: m.is_sms ? 'var(--success-bg)' : 'var(--orange-soft)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '12px', fontWeight: 800,
                color: m.is_sms ? 'var(--success)' : 'var(--orange)',
              }}>{(m.sender_name || '?')[0]?.toUpperCase()}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: theme.textPrimary }}>
                    {m.sender_name || 'Unknown'}
                  </span>
                  <span style={{ fontSize: '9px', color: theme.textMuted, flexShrink: 0 }}>{timeAgo(m.created_at)}</span>
                </div>
                <div style={{
                  fontSize: '11px', color: theme.textMuted, marginTop: '1px',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{m.body}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </WidgetShell>
  );
}
