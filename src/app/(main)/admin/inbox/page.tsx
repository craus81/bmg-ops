'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';

type ThreadFilter = 'all' | 'unread' | 'mine' | 'unassigned' | 'archived';

interface ThreadSummary {
  id: string;
  external_contact_id: string;
  customer_id: string | null;
  context_entity_type: string;
  context_entity_id: string | null;
  status: 'open' | 'archived';
  assigned_to: string | null;
  subject: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
  unread_count: number;
  contact: { id: string; name: string | null; phone: string | null; email: string | null; is_unknown: boolean; title: string | null; is_primary: boolean } | null;
  customer: { id: string; company_name: string | null } | null;
  latestMessage: { direction: 'inbound' | 'outbound'; body: string | null; sent_at: string; channel: string } | null;
}

interface ThreadDetail {
  thread: ThreadSummary & { created_at: string; updated_at: string };
  messages: {
    id: string;
    direction: 'inbound' | 'outbound';
    channel: 'sms' | 'mms' | 'email';
    body: string | null;
    attachments: any[];
    sent_at: string;
    delivery_status: string | null;
    sender: { id: string; full_name: string | null } | null;
  }[];
  entity: any;
}

const CONTEXT_LABELS: Record<string, string> = {
  fleet_checkin: 'Vehicle',
  purchase_order: 'PO',
  graphics_job: 'Graphics Job',
  estimate: 'Estimate',
  general: 'General',
};

export default function AdminInboxPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isAdmin, isSales } = useAuth();
  const dialog = useDialog();

  const [filter, setFilter] = useState<ThreadFilter>('all');
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [composeBody, setComposeBody] = useState('');
  const [composeChannel, setComposeChannel] = useState<'sms' | 'mms' | 'email'>('sms');
  const [sending, setSending] = useState(false);

  const threadContainerRef = useRef<HTMLDivElement>(null);

  const loadThreads = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (filter === 'archived') qs.set('status', 'archived');
    else qs.set('status', 'open');
    if (filter === 'unread') qs.set('unread', '1');
    if (filter === 'mine') qs.set('assigned', 'me');
    if (filter === 'unassigned') qs.set('assigned', 'unassigned');

    const res = await fetch(`/api/customer-threads?${qs.toString()}`);
    const data = await res.json();
    setThreads(data.threads || []);
    setLoading(false);
  }, [filter]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    const res = await fetch(`/api/customer-threads/${id}`);
    const data = await res.json();
    setDetail(data as ThreadDetail);
    setDetailLoading(false);

    // Mark read
    await fetch(`/api/customer-threads/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markRead: true }),
    });
    setThreads(prev => prev.map(t => t.id === id ? { ...t, unread_count: 0 } : t));
  }, []);

  useEffect(() => {
    if (!user) return;
    if (!isAdmin && !isSales) { router.push('/home'); return; }
    loadThreads();
  }, [user, isAdmin, isSales, router, loadThreads]);

  // Deep-link ?thread=id auto-selects that thread
  useEffect(() => {
    const id = searchParams?.get('thread');
    if (id) setSelectedId(id);
  }, [searchParams]);

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    if (detail && threadContainerRef.current) {
      threadContainerRef.current.scrollTop = threadContainerRef.current.scrollHeight;
    }
  }, [detail]);

  const assignThread = async (assignToMe: boolean) => {
    if (!detail) return;
    const newAssigned = assignToMe ? user?.id : null;
    await fetch(`/api/customer-threads/${detail.thread.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assigned_to: newAssigned }),
    });
    await loadDetail(detail.thread.id);
    await loadThreads();
  };

  const archiveThread = async () => {
    if (!detail) return;
    await fetch(`/api/customer-threads/${detail.thread.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'archived' }),
    });
    await loadThreads();
    setSelectedId(null);
  };

  const sendMessage = async () => {
    if (!detail || !composeBody.trim() || sending) return;
    setSending(true);
    const res = await fetch(`/api/customer-threads/${detail.thread.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: composeChannel, body: composeBody.trim() }),
    });
    const data = await res.json();
    if (!res.ok) {
      await dialog.alert('Send failed: ' + (data.error || 'Unknown error'));
    } else {
      if (data.dispatch?.status === 'pending') {
        await dialog.alert('Message saved, but SMS provider is disabled. It will send once SMS_PROVIDER_ENABLED is true.');
      }
      setComposeBody('');
      await loadDetail(detail.thread.id);
      await loadThreads();
    }
    setSending(false);
  };

  const formatTime = (iso: string | null) => {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  const entityLabel = (t: ThreadSummary) => {
    const ctx = CONTEXT_LABELS[t.context_entity_type] || t.context_entity_type;
    return t.context_entity_id ? `${ctx} · linked` : ctx;
  };

  const contactDisplayName = (t: ThreadSummary) => {
    if (t.contact?.is_unknown) return t.contact.name || t.contact.phone || 'Unknown';
    return t.contact?.name || t.customer?.company_name || t.contact?.phone || 'Unknown';
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800 }}>Inbox</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Customer comms threaded by vehicle / PO / job</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '6px', marginBottom: '16px', flexWrap: 'wrap' }}>
        {(['all', 'unread', 'mine', 'unassigned', 'archived'] as ThreadFilter[]).map(f => (
          <button
            key={f}
            onClick={() => { setFilter(f); setSelectedId(null); }}
            style={{
              padding: '6px 12px', borderRadius: '999px',
              border: `1px solid ${filter === f ? 'var(--accent, #2563eb)' : 'var(--border)'}`,
              background: filter === f ? 'var(--accent, #2563eb)' : 'var(--card)',
              color: filter === f ? '#fff' : 'var(--text-secondary, #475569)',
              fontSize: '12px', fontWeight: 700, cursor: 'pointer', textTransform: 'capitalize',
            }}
          >{f === 'mine' ? 'Assigned to me' : f}</button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 340px) 1fr', gap: '16px', alignItems: 'flex-start' }}>
        {/* Thread list */}
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: '20px', color: 'var(--text-muted)', fontSize: '13px' }}>Loading...</div>
          ) : threads.length === 0 ? (
            <div style={{ padding: '28px', color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center' }}>No threads in this view.</div>
          ) : (
            <div style={{ maxHeight: '72vh', overflow: 'auto' }}>
              {threads.map(t => {
                const selected = selectedId === t.id;
                const preview = t.latestMessage?.body?.slice(0, 80) || (t.subject || '(no messages)');
                return (
                  <button
                    key={t.id}
                    onClick={() => setSelectedId(t.id)}
                    style={{
                      width: '100%', padding: '12px 14px', textAlign: 'left',
                      background: selected ? 'color-mix(in srgb, var(--accent, #2563eb) 8%, var(--card))' : 'var(--card)',
                      border: 'none',
                      borderBottom: '1px solid var(--border)',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                      <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {contactDisplayName(t)}
                        {t.unread_count > 0 && (
                          <span style={{ marginLeft: '6px', background: 'var(--accent, #2563eb)', color: '#fff', padding: '1px 6px', borderRadius: '8px', fontSize: '10px' }}>{t.unread_count}</span>
                        )}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0 }}>{formatTime(t.last_message_at)}</div>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      <span>{entityLabel(t)}</span>
                      {t.contact?.is_unknown && <span style={{ color: 'var(--warning, #f59e0b)', fontWeight: 700 }}>unknown sender</span>}
                      {!t.assigned_to && t.status === 'open' && <span style={{ color: 'var(--text-muted)' }}>unassigned</span>}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary, #475569)', marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.latestMessage?.direction === 'outbound' && <span style={{ color: 'var(--text-muted)' }}>You: </span>}
                      {preview}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Detail panel */}
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', minHeight: '60vh', display: 'flex', flexDirection: 'column' }}>
          {!selectedId ? (
            <div style={{ padding: '40px', color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center' }}>
              Select a thread to view the conversation.
            </div>
          ) : detailLoading || !detail ? (
            <div style={{ padding: '20px', color: 'var(--text-muted)' }}>Loading...</div>
          ) : (
            <>
              {/* Header */}
              <div style={{ padding: '14px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '15px', fontWeight: 800 }}>
                      {detail.thread.contact?.name || detail.thread.contact?.phone || 'Unknown'}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      {detail.thread.customer?.company_name && <span>{detail.thread.customer.company_name}</span>}
                      {detail.thread.contact?.phone && <span>{detail.thread.contact.phone}</span>}
                      {detail.thread.contact?.email && <span>{detail.thread.contact.email}</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                    <button
                      onClick={() => assignThread(detail.thread.assigned_to !== user?.id)}
                      style={{ padding: '6px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
                    >{detail.thread.assigned_to === user?.id ? 'Unassign me' : 'Assign to me'}</button>
                    <button
                      onClick={archiveThread}
                      style={{ padding: '6px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
                    >Archive</button>
                  </div>
                </div>

                {/* Entity context panel */}
                {detail.entity && (
                  <div style={{ marginTop: '10px', padding: '8px 10px', borderRadius: '8px', background: 'var(--subtle-bg, #f8fafc)', fontSize: '12px' }}>
                    <span style={{ fontWeight: 700 }}>{CONTEXT_LABELS[detail.thread.context_entity_type]}:</span>{' '}
                    {detail.thread.context_entity_type === 'fleet_checkin' && (
                      <a
                        href={`/vehicles/${detail.entity.vin}/pick-list`}
                        style={{ color: 'var(--accent, #2563eb)', textDecoration: 'none' }}
                      >
                        {[detail.entity.vehicle_year, detail.entity.vehicle_make, detail.entity.vehicle_model].filter(Boolean).join(' ')} · {detail.entity.vin}
                      </a>
                    )}
                    {detail.thread.context_entity_type === 'purchase_order' && `PO ${detail.entity.po_number}`}
                    {detail.thread.context_entity_type === 'graphics_job' && `Job ${detail.entity.job_number} · ${detail.entity.title || ''}`}
                    {detail.thread.context_entity_type === 'estimate' && `Estimate ${detail.entity.estimate_number} · ${detail.entity.title || ''}`}
                  </div>
                )}
              </div>

              {/* Message list */}
              <div ref={threadContainerRef} style={{ flex: 1, padding: '14px', overflow: 'auto', minHeight: '300px', maxHeight: '55vh', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {detail.messages.length === 0 && (
                  <div style={{ color: 'var(--text-muted)', fontSize: '12px', textAlign: 'center' }}>No messages yet.</div>
                )}
                {detail.messages.map(m => {
                  const outbound = m.direction === 'outbound';
                  return (
                    <div key={m.id} style={{ display: 'flex', justifyContent: outbound ? 'flex-end' : 'flex-start' }}>
                      <div style={{
                        maxWidth: '70%',
                        padding: '8px 12px', borderRadius: '14px',
                        background: outbound ? 'var(--accent, #2563eb)' : 'var(--subtle-bg, #f1f5f9)',
                        color: outbound ? '#fff' : 'var(--text-primary)',
                        fontSize: '13px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      }}>
                        {m.body}
                        {m.attachments && m.attachments.length > 0 && (
                          <div style={{ marginTop: '6px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                            {m.attachments.map((a: any, i: number) => (
                              <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '11px', color: outbound ? '#fff' : 'var(--accent, #2563eb)' }}>attachment {i + 1}</a>
                            ))}
                          </div>
                        )}
                        <div style={{ fontSize: '10px', marginTop: '4px', opacity: 0.7 }}>
                          {m.channel.toUpperCase()} · {formatTime(m.sent_at)}
                          {m.sender?.full_name && ` · ${m.sender.full_name}`}
                          {m.delivery_status && m.delivery_status !== 'sent' && m.delivery_status !== 'received' && ` · ${m.delivery_status}`}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Composer */}
              {detail.thread.status === 'open' && (
                <div style={{ padding: '12px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {(['sms', 'email'] as const).map(ch => (
                      <button
                        key={ch}
                        onClick={() => setComposeChannel(ch)}
                        disabled={ch === 'sms' && !detail.thread.contact?.phone || ch === 'email' && !detail.thread.contact?.email}
                        style={{
                          padding: '4px 10px', borderRadius: '8px',
                          border: `1px solid ${composeChannel === ch ? 'var(--accent, #2563eb)' : 'var(--border)'}`,
                          background: composeChannel === ch ? 'var(--accent, #2563eb)' : 'var(--card)',
                          color: composeChannel === ch ? '#fff' : 'var(--text-secondary, #475569)',
                          fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                          opacity: (ch === 'sms' && !detail.thread.contact?.phone) || (ch === 'email' && !detail.thread.contact?.email) ? 0.4 : 1,
                        }}
                      >{ch.toUpperCase()}</button>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <textarea
                      value={composeBody}
                      onChange={e => setComposeBody(e.target.value)}
                      placeholder={composeChannel === 'sms' ? 'Type an SMS...' : 'Type an email...'}
                      rows={2}
                      style={{
                        flex: 1, padding: '8px 10px', borderRadius: '8px',
                        border: '1px solid var(--border)', background: 'var(--background, #fff)',
                        fontSize: '13px', fontFamily: 'inherit', resize: 'vertical',
                      }}
                    />
                    <button
                      onClick={sendMessage}
                      disabled={sending || !composeBody.trim()}
                      style={{
                        padding: '8px 14px', borderRadius: '8px',
                        border: 'none', background: 'var(--accent, #2563eb)', color: '#fff',
                        fontSize: '13px', fontWeight: 700,
                        cursor: sending ? 'default' : 'pointer',
                        opacity: composeBody.trim() && !sending ? 1 : 0.5,
                      }}
                    >{sending ? 'Sending...' : 'Send'}</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
