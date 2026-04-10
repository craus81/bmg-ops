'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';
import type { Profile, Conversation, Message } from '@/lib/types';

interface ConversationWithDetails extends Conversation {
  otherUser: Profile;
  lastMessage?: Message;
  unreadCount: number;
}

export default function MessagesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const supabase = createClient();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [conversations, setConversations] = useState<ConversationWithDetails[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);

  // Active conversation
  const [activeConvoId, setActiveConvoId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);

  const EMOJI_LIST = ['👍', '👎', '😀', '😂', '🤣', '😊', '🙏', '🔥', '❤️', '💯', '✅', '❌', '⚡', '🎉', '👀', '💪', '🚚', '🔧', '📋', '📞', '📧', '⏰', '📍', '🏗️'];

  // New conversation
  const [showNewConvo, setShowNewConvo] = useState(false);
  const [userSearch, setUserSearch] = useState('');

  useEffect(() => {
    if (!user) return;
    loadProfiles();
    loadConversations();

    // Check for ?to= param (deep link to start convo with someone)
    const toUserId = searchParams.get('to');
    if (toUserId) {
      openOrCreateConversation(toUserId);
    }
  }, [user]);

  // Realtime subscription for new messages
  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel('messages-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const msg = payload.new as Message;
          // If it's in the active conversation, add it
          if (msg.conversation_id === activeConvoId) {
            setMessages(prev => {
              if (prev.some(m => m.id === msg.id)) return prev;
              return [...prev, msg];
            });
            // Mark as read if we're the recipient
            if (msg.sender_id !== user.id) {
              supabase.from('messages').update({ read_at: new Date().toISOString() }).eq('id', msg.id).then(() => {});
            }
            setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
          }
          // Update conversation list
          updateConversationPreview(msg);
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user, activeConvoId]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const loadProfiles = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, email, role, status')
      .eq('status', 'approved')
      .order('full_name');
    setProfiles((data as Profile[]) || []);
  };

  const loadConversations = async () => {
    if (!user) return;

    // Get all conversations for this user
    const { data: convos } = await supabase
      .from('conversations')
      .select('*')
      .or(`participant_1.eq.${user.id},participant_2.eq.${user.id}`)
      .order('last_message_at', { ascending: false });

    if (!convos || convos.length === 0) {
      setConversations([]);
      setLoading(false);
      return;
    }

    // Get profiles for all participants
    const otherUserIds = convos.map(c =>
      c.participant_1 === user.id ? c.participant_2 : c.participant_1
    );
    const { data: otherProfiles } = await supabase
      .from('profiles')
      .select('id, full_name, email, role, status')
      .in('id', otherUserIds);

    const profileMap = new Map((otherProfiles || []).map(p => [p.id, p]));

    // Get last message and unread count for each conversation
    const enriched: ConversationWithDetails[] = [];
    for (const convo of convos) {
      const otherId = convo.participant_1 === user.id ? convo.participant_2 : convo.participant_1;
      const otherUser = profileMap.get(otherId);
      if (!otherUser) continue;

      const { data: lastMsgs } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', convo.id)
        .order('created_at', { ascending: false })
        .limit(1);

      const { count: unread } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('conversation_id', convo.id)
        .neq('sender_id', user.id)
        .is('read_at', null);

      enriched.push({
        ...convo,
        otherUser: otherUser as Profile,
        lastMessage: lastMsgs?.[0] as Message | undefined,
        unreadCount: unread || 0,
      });
    }

    setConversations(enriched);
    setLoading(false);
  };

  const updateConversationPreview = (msg: Message) => {
    setConversations(prev => {
      const idx = prev.findIndex(c => c.id === msg.conversation_id);
      if (idx === -1) {
        // New conversation — reload full list
        loadConversations();
        return prev;
      }
      const updated = [...prev];
      updated[idx] = {
        ...updated[idx],
        lastMessage: msg,
        last_message_at: msg.created_at,
        unreadCount: msg.sender_id !== user?.id && msg.conversation_id !== activeConvoId
          ? updated[idx].unreadCount + 1
          : updated[idx].unreadCount,
      };
      // Re-sort by last message
      updated.sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime());
      return updated;
    });
  };

  const openConversation = async (convoId: string) => {
    setActiveConvoId(convoId);
    setMessages([]);

    // Load messages
    const { data } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', convoId)
      .order('created_at', { ascending: true })
      .limit(100);

    setMessages((data as Message[]) || []);

    // Mark all unread messages as read
    if (user) {
      await supabase
        .from('messages')
        .update({ read_at: new Date().toISOString() })
        .eq('conversation_id', convoId)
        .neq('sender_id', user.id)
        .is('read_at', null);

      // Update local unread count
      setConversations(prev =>
        prev.map(c => c.id === convoId ? { ...c, unreadCount: 0 } : c)
      );
    }

    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      inputRef.current?.focus();
    }, 100);
  };

  const openOrCreateConversation = async (otherUserId: string) => {
    if (!user) return;

    // Check if conversation already exists
    const [p1, p2] = [user.id, otherUserId].sort();
    const { data: existing } = await supabase
      .from('conversations')
      .select('*')
      .eq('participant_1', p1)
      .eq('participant_2', p2)
      .maybeSingle();

    if (existing) {
      openConversation(existing.id);
      return;
    }

    // Create new conversation
    const { data: newConvo } = await supabase
      .from('conversations')
      .insert({ participant_1: p1, participant_2: p2 })
      .select()
      .single();

    if (newConvo) {
      await loadConversations();
      openConversation(newConvo.id);
    }
  };

  const renderMessageBody = (body: string) => {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const imageExts = /\.(gif|png|jpg|jpeg|webp)(\?.*)?$/i;
    const gifDomains = /giphy\.com|tenor\.com|imgur\.com/i;
    const parts = body.split(urlRegex);
    return parts.map((part, i) => {
      if (!urlRegex.test(part)) return part;
      // Render images/gifs inline
      if (imageExts.test(part) || gifDomains.test(part)) {
        // Convert giphy/tenor page URLs to direct image if possible
        let imgUrl = part;
        if (part.includes('giphy.com') && !part.includes('/media/')) {
          // Try to use as-is, giphy URLs often work as images
        }
        return (
          <span key={i} style={{ display: 'block', marginTop: '4px' }}>
            <img src={imgUrl} alt="" style={{ maxWidth: '100%', maxHeight: '250px', borderRadius: '8px', display: 'block' }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).insertAdjacentHTML('afterend', `<a href="${part}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline">${part}</a>`); }} />
          </span>
        );
      }
      return <a key={i} href={part} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline', wordBreak: 'break-all' }}>{part}</a>;
    });
  };

  const insertEmoji = (emoji: string) => {
    setNewMessage(prev => prev + emoji);
    // Keep emoji picker open — user closes it by clicking the emoji button or tapping the input
  };

  const sendMessage = async () => {
    if (!newMessage.trim() || !activeConvoId || !user || sending) return;
    setSending(true);
    const body = newMessage.trim();
    setNewMessage('');

    const { data: msg, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: activeConvoId,
        sender_id: user.id,
        body,
      })
      .select()
      .single();

    if (!error && msg) {
      // Update conversation last_message_at
      await supabase
        .from('conversations')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', activeConvoId);

      // Add to local messages if not already there (realtime might beat us)
      setMessages(prev => {
        if (prev.some(m => m.id === msg.id)) return prev;
        return [...prev, msg as Message];
      });

      // Fire-and-forget: trigger SMS delivery to recipient if they have it enabled
      fetch('/api/messages/send-sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: msg.id,
          conversationId: activeConvoId,
          senderId: user.id,
          body,
        }),
      }).catch(() => {}); // Silent fail — SMS is best-effort
    }

    setSending(false);
    inputRef.current?.focus();
  };

  const getActiveConvo = () => conversations.find(c => c.id === activeConvoId);
  const totalUnread = conversations.reduce((sum, c) => sum + c.unreadCount, 0);

  const filteredUsers = profiles.filter(p => {
    if (p.id === user?.id) return false;
    if (!userSearch) return true;
    const s = userSearch.toLowerCase();
    return p.full_name?.toLowerCase().includes(s) || p.email?.toLowerCase().includes(s);
  });

  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  const roleColor = (role: string) => {
    switch (role) {
      case 'admin': return '#60a5fa';
      case 'production': case 'graphics_production': return '#a78bfa';
      case 'sales': return '#4ade80';
      case 'field_tech': return '#fbbf24';
      case 'shop_tech': return '#38bdf8';
      default: return 'var(--text-body)';
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: '10px',
    border: '1px solid var(--border)', background: 'var(--bg)',
    color: 'var(--text-body)', fontSize: '14px', outline: 'none',
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <div style={{ width: '36px', height: '36px', border: '3px solid var(--border)', borderTopColor: theme.orange, borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
        <div style={{ color: 'var(--text-label)', marginTop: '12px', fontSize: '13px', fontWeight: 600 }}>Loading messages...</div>
      </div>
    );
  }

  // ═══════════ ACTIVE CHAT VIEW ═══════════
  if (activeConvoId) {
    const convo = getActiveConvo();
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 140px)' }}>
        {/* Chat header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0',
          borderBottom: '1px solid var(--border)', marginBottom: '8px', flexShrink: 0,
        }}>
          <button
            onClick={() => { setActiveConvoId(null); loadConversations(); }}
            style={{ background: 'none', border: 'none', color: '#60a5fa', fontSize: '16px', cursor: 'pointer', padding: '4px 8px' }}
          >
            ←
          </button>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-body)' }}>
              {convo?.otherUser?.full_name || convo?.otherUser?.email || 'Unknown'}
            </div>
            {convo?.otherUser?.role && (
              <div style={{ fontSize: '10px', fontWeight: 700, color: roleColor(convo.otherUser.role), textTransform: 'capitalize' }}>
                {convo.otherUser.role}
              </div>
            )}
          </div>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px', paddingBottom: '8px' }}>
          {messages.length === 0 && (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-label)', fontSize: '13px' }}>
              Start a conversation with {convo?.otherUser?.full_name || 'this person'}
            </div>
          )}
          {messages.map((msg, idx) => {
            const isMe = msg.sender_id === user?.id;
            const showTimestamp = idx === 0 ||
              new Date(msg.created_at).getTime() - new Date(messages[idx - 1].created_at).getTime() > 300000; // 5 min gap

            return (
              <div key={msg.id}>
                {showTimestamp && (
                  <div style={{ textAlign: 'center', fontSize: '10px', color: 'var(--text-label)', margin: '8px 0 4px', fontWeight: 600 }}>
                    {formatTime(msg.created_at)}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: isMe ? 'flex-end' : 'flex-start' }}>
                  <div style={{
                    maxWidth: '80%', padding: '8px 12px', borderRadius: '14px',
                    background: isMe ? '#3b82f6' : 'var(--border)',
                    color: isMe ? '#fff' : 'var(--text-body)',
                    fontSize: '13px', lineHeight: 1.4,
                    borderBottomRightRadius: isMe ? '4px' : '14px',
                    borderBottomLeftRadius: isMe ? '14px' : '4px',
                  }}>
                    <span style={{ whiteSpace: 'pre-wrap' }}>{renderMessageBody(msg.body)}</span>
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {/* Emoji picker */}
        {showEmoji && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px', padding: '8px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '10px', marginBottom: '4px' }}>
            {EMOJI_LIST.map(e => (
              <button key={e} onClick={() => insertEmoji(e)} style={{ padding: '4px 6px', borderRadius: '6px', border: 'none', background: 'transparent', fontSize: '18px', cursor: 'pointer' }}>{e}</button>
            ))}
          </div>
        )}

        {/* Input */}
        <div style={{ display: 'flex', gap: '8px', padding: '8px 0', borderTop: '1px solid var(--border)', flexShrink: 0, alignItems: 'flex-end' }}>
          <button onClick={() => setShowEmoji(!showEmoji)} style={{ padding: '8px', borderRadius: '8px', border: 'none', background: showEmoji ? 'rgba(59,130,246,0.15)' : 'transparent', fontSize: '18px', cursor: 'pointer', flexShrink: 0 }}>😀</button>
          <textarea
            ref={inputRef as any}
            value={newMessage}
            onChange={e => setNewMessage(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
            placeholder="Type a message..."
            rows={1}
            style={{ ...inputStyle, resize: 'none', minHeight: '40px', maxHeight: '120px', lineHeight: '1.4' }}
            onInput={e => { const t = e.target as HTMLTextAreaElement; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 120) + 'px'; }}
          />
          <button
            onClick={sendMessage}
            disabled={!newMessage.trim() || sending}
            style={{
              padding: '10px 16px', borderRadius: '10px',
              background: !newMessage.trim() ? 'var(--border)' : '#3b82f6',
              color: '#fff', fontWeight: 800, fontSize: '14px',
              border: 'none', cursor: 'pointer', flexShrink: 0,
              opacity: !newMessage.trim() ? 0.5 : 1,
            }}
          >
            {sending ? '...' : '→'}
          </button>
        </div>
      </div>
    );
  }

  // ═══════════ CONVERSATION LIST VIEW ═══════════
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
        <div style={{ fontSize: '22px', fontWeight: 800 }}>Messages</div>
        <button
          onClick={() => setShowNewConvo(true)}
          style={{
            padding: '8px 14px', borderRadius: '10px', background: '#3b82f6',
            color: '#fff', fontWeight: 800, fontSize: '12px', border: 'none', cursor: 'pointer',
          }}
        >
          + New Message
        </button>
      </div>

      {/* Conversation list */}
      {conversations.length === 0 && !showNewConvo && (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px' }}>--</div>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-body)', marginBottom: '4px' }}>No messages yet</div>
          <div style={{ fontSize: '12px', color: 'var(--text-label)' }}>Start a conversation with a team member</div>
        </div>
      )}

      {conversations.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {conversations.map(convo => (
            <button
              key={convo.id}
              onClick={() => openConversation(convo.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '12px', borderRadius: '12px',
                background: convo.unreadCount > 0 ? 'rgba(59,130,246,0.06)' : 'var(--subtle-bg)',
                border: `1px solid ${convo.unreadCount > 0 ? 'rgba(59,130,246,0.2)' : 'var(--border)'}`,
                cursor: 'pointer', textAlign: 'left', width: '100%',
              }}
            >
              {/* Avatar */}
              <div style={{
                width: '40px', height: '40px', borderRadius: '50%',
                background: `${roleColor(convo.otherUser.role)}22`,
                border: `2px solid ${roleColor(convo.otherUser.role)}44`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '16px', fontWeight: 800, color: roleColor(convo.otherUser.role),
                flexShrink: 0,
              }}>
                {(convo.otherUser.full_name || convo.otherUser.email || '?')[0].toUpperCase()}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{
                    fontSize: '13px', fontWeight: convo.unreadCount > 0 ? 800 : 600,
                    color: 'var(--text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {convo.otherUser.full_name || convo.otherUser.email}
                  </div>
                  {convo.lastMessage && (
                    <div style={{ fontSize: '10px', color: 'var(--text-label)', flexShrink: 0, marginLeft: '8px' }}>
                      {formatTime(convo.lastMessage.created_at)}
                    </div>
                  )}
                </div>
                <div style={{
                  fontSize: '11px', marginTop: '2px',
                  color: convo.unreadCount > 0 ? 'var(--text-body)' : 'var(--text-label)',
                  fontWeight: convo.unreadCount > 0 ? 600 : 400,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {convo.lastMessage
                    ? `${convo.lastMessage.sender_id === user?.id ? 'You: ' : ''}${convo.lastMessage.body}`
                    : 'No messages yet'}
                </div>
              </div>

              {/* Unread badge */}
              {convo.unreadCount > 0 && (
                <div style={{
                  minWidth: '20px', height: '20px', borderRadius: '10px',
                  background: '#3b82f6', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontSize: '10px', fontWeight: 800,
                  color: '#fff', padding: '0 5px', flexShrink: 0,
                }}>
                  {convo.unreadCount}
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {/* New Conversation Modal */}
      {showNewConvo && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div style={{ background: 'var(--subtle-bg)', border: '1px solid rgba(59,130,246,0.3)', borderRadius: '14px', padding: '18px', maxWidth: '400px', width: '100%', maxHeight: '70vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-body)' }}>New Message</div>
              <button onClick={() => { setShowNewConvo(false); setUserSearch(''); }} style={{ background: 'none', border: 'none', color: 'var(--text-label)', fontSize: '18px', cursor: 'pointer' }}>✕</button>
            </div>

            <input
              placeholder="Search team members..."
              value={userSearch}
              onChange={e => setUserSearch(e.target.value)}
              autoFocus
              style={{ ...inputStyle, marginBottom: '10px' }}
            />

            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              {filteredUsers.map(p => (
                <button
                  key={p.id}
                  onClick={() => {
                    setShowNewConvo(false);
                    setUserSearch('');
                    openOrCreateConversation(p.id);
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '10px', borderRadius: '8px',
                    background: 'var(--bg)', border: '1px solid var(--border)',
                    cursor: 'pointer', textAlign: 'left', width: '100%',
                  }}
                >
                  <div style={{
                    width: '32px', height: '32px', borderRadius: '50%',
                    background: `${roleColor(p.role)}22`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '13px', fontWeight: 800, color: roleColor(p.role),
                  }}>
                    {(p.full_name || p.email || '?')[0].toUpperCase()}
                  </div>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-body)' }}>
                      {p.full_name || p.email}
                    </div>
                    <div style={{ fontSize: '10px', color: roleColor(p.role), fontWeight: 600, textTransform: 'capitalize' }}>
                      {p.role}
                    </div>
                  </div>
                </button>
              ))}
              {filteredUsers.length === 0 && (
                <div style={{ textAlign: 'center', padding: '16px', fontSize: '12px', color: 'var(--text-label)' }}>
                  {userSearch ? 'No matching users found.' : 'No other users available.'}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
