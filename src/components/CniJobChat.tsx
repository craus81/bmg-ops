'use client';

import { useState, useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase-browser';
import MentionTextArea, { reportMentions } from '@/components/MentionTextArea';

interface Message {
  id: string;
  sender_id: string;
  body: string;
  read_at: string | null;
  created_at: string;
  sender_name?: string;
}

interface CniJobChatProps {
  jobId: string;
  userId: string;
  backPath: string;
  jobNumber: string;
  jobTitle: string;
}

export default function CniJobChat({ jobId, userId, backPath, jobNumber, jobTitle }: CniJobChatProps) {
  const supabase = createClient();
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMsg, setNewMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadMessages();
    // Poll every 10s for new messages
    const interval = setInterval(loadMessages, 10000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [jobId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const loadMessages = async () => {
    const { data } = await supabase
      .from('cni_job_messages')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: true });

    if (data) {
      // Get sender names
      const senderIds = [...new Set(data.map((m: any) => m.sender_id))];
      let nameMap: Record<string, string> = {};
      if (senderIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', senderIds);
        if (profiles) profiles.forEach((p: any) => { nameMap[p.id] = p.full_name; });
      }
      setMessages(data.map((m: any) => ({ ...m, sender_name: nameMap[m.sender_id] || 'Unknown' })));

      // Mark unread messages as read
      const unread = data.filter((m: any) => !m.read_at && m.sender_id !== userId);
      if (unread.length > 0) {
        await supabase
          .from('cni_job_messages')
          .update({ read_at: new Date().toISOString() })
          .in('id', unread.map((m: any) => m.id));
      }
    }

    setLoading(false);
  };

  const sendMessage = async () => {
    if (!newMsg.trim() || sending) return;
    setSending(true);

    const body = newMsg.trim();
    const { error } = await supabase.from('cni_job_messages').insert({
      job_id: jobId,
      sender_id: userId,
      body,
    });

    if (!error) {
      reportMentions({
        text: body,
        sourceType: 'cni_job_message',
        sourceId: jobId,
        contextLabel: `${jobNumber} — ${jobTitle}`,
        contextUrl: window.location.pathname,
      });
    }

    setNewMsg('');
    await loadMessages();
    setSending(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 120px)' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '12px', padding: '0 0 14px 0',
        borderBottom: '1px solid var(--border)',
      }}>
        <a href={backPath} style={{ fontSize: '20px', color: 'var(--text-muted)', textDecoration: 'none' }}>←</a>
        <div>
          <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>Messages</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{jobNumber} • {jobTitle}</div>
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 0' }}>
        {loading ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '20px' }}>Loading...</div>
        ) : messages.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px 20px' }}>
            <div style={{ fontSize: '13px' }}>No messages yet. Start the conversation.</div>
          </div>
        ) : (
          messages.map(msg => {
            const isMe = msg.sender_id === userId;
            return (
              <div
                key={msg.id}
                style={{
                  display: 'flex',
                  justifyContent: isMe ? 'flex-end' : 'flex-start',
                  marginBottom: '10px',
                }}
              >
                <div style={{
                  maxWidth: '80%', padding: '10px 14px', borderRadius: '14px',
                  background: isMe ? 'var(--orange)' : 'var(--card)',
                  color: isMe ? '#fff' : 'var(--text-primary)',
                  border: isMe ? 'none' : '1px solid var(--border)',
                }}>
                  {!isMe && (
                    <div style={{ fontSize: '11px', fontWeight: 700, marginBottom: '2px', opacity: 0.7 }}>
                      {msg.sender_name}
                    </div>
                  )}
                  <div style={{ fontSize: '13px', lineHeight: '1.4', whiteSpace: 'pre-wrap' }}>
                    {msg.body}
                  </div>
                  <div style={{
                    fontSize: '10px', marginTop: '4px', textAlign: 'right',
                    opacity: 0.6,
                  }}>
                    {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    {isMe && msg.read_at && ' ✓✓'}
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{
        display: 'flex', gap: '8px', padding: '12px 0',
        borderTop: '1px solid var(--border)',
      }}>
        <MentionTextArea
          value={newMsg}
          onChange={setNewMsg}
          onKeyDown={handleKeyDown}
          placeholder="Type a message... (@ tags a teammate)"
          rows={1}
          style={{
            flex: 1, padding: '10px 14px', borderRadius: '12px',
            border: '1px solid var(--border)', background: 'var(--input-bg)',
            color: 'var(--text-body)', fontSize: '14px', resize: 'none',
            minHeight: '42px', maxHeight: '100px',
          }}
        />
        <button
          onClick={sendMessage}
          disabled={!newMsg.trim() || sending}
          style={{
            padding: '10px 16px', borderRadius: '12px', fontSize: '14px', fontWeight: 700,
            background: newMsg.trim() ? 'var(--orange)' : 'var(--text-muted)',
            color: '#fff', border: 'none', alignSelf: 'flex-end',
          }}
        >
          {sending ? '...' : '→'}
        </button>
      </div>
    </div>
  );
}
