'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';
import UniversalSearch from '@/components/UniversalSearch';

interface HeaderProps {
  clockStatus: 'out' | 'in' | 'break';
  activePartNumber?: string;
  activeEndCustomer?: string;
}

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  url?: string | null;
  vehicle_id?: string;
  read_at: string | null;
  created_at: string;
}

export default function Header({ clockStatus, activePartNumber, activeEndCustomer }: HeaderProps) {
  const { user, profile, isAdmin, signOut } = useAuth();
  const router = useRouter();
  const [showMenu, setShowMenu] = useState(false);
  const [showSwitchModal, setShowSwitchModal] = useState(false);
  const [switchEmail, setSwitchEmail] = useState('');
  const [switchPassword, setSwitchPassword] = useState('');
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);

  // Notifications state
  const [showNotifications, setShowNotifications] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loadingNotifs, setLoadingNotifs] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);

  // Search
  const [showSearch, setShowSearch] = useState(false);

  // Messaging unread count
  const [unreadMessages, setUnreadMessages] = useState(0);

  const { createClient } = require('@/lib/supabase-browser');
  const supabase = createClient();

  // Close menu on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setShowNotifications(false);
      }
    };
    if (showMenu || showNotifications) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showMenu, showNotifications]);

  // Set dynamic page title based on role
  useEffect(() => {
    document.title = isAdmin ? 'BMG FleetSuite' : 'BMG Fleet GO';
  }, [isAdmin]);

  // Load unread count on mount and poll every 30s
  useEffect(() => {
    if (!user) return;
    loadUnreadCount();
    const interval = setInterval(loadUnreadCount, 30000);
    return () => clearInterval(interval);
  }, [user]);

  const loadUnreadCount = async () => {
    if (!user) return;
    const { count } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .is('read_at', null);
    setUnreadCount(count || 0);
  };

  // Load unread message count and subscribe to realtime changes
  useEffect(() => {
    if (!user) return;
    loadUnreadMessages();
    const interval = setInterval(loadUnreadMessages, 30000);

    // Subscribe to new messages for instant badge updates
    const channel = supabase
      .channel('header-messages')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload: any) => {
        if (payload.new && payload.new.sender_id !== user.id) {
          setUnreadMessages((c: number) => c + 1);
        }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, () => {
        // A message was marked as read — refresh count
        loadUnreadMessages();
      })
      .subscribe();

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, [user]);

  const loadUnreadMessages = async () => {
    if (!user) return;
    // Count messages where I'm the recipient (not sender) and read_at is null
    // First get my conversations
    const { data: convos } = await supabase
      .from('conversations')
      .select('id')
      .or(`participant_1.eq.${user.id},participant_2.eq.${user.id}`);
    if (!convos || convos.length === 0) { setUnreadMessages(0); return; }
    const convoIds = convos.map((c: any) => c.id);
    const { count } = await supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .in('conversation_id', convoIds)
      .neq('sender_id', user.id)
      .is('read_at', null);
    setUnreadMessages(count || 0);
  };

  const loadNotifications = async () => {
    if (!user) return;
    setLoadingNotifs(true);
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(30);
    setNotifications(data || []);
    setLoadingNotifs(false);
  };

  const handleBellClick = () => {
    if (!showNotifications) {
      loadNotifications();
    }
    setShowNotifications(!showNotifications);
    setShowMenu(false);
  };

  const markAsRead = async (id: string) => {
    await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id);
    setNotifications((prev) =>
      prev.map((n) => n.id === id ? { ...n, read_at: new Date().toISOString() } : n)
    );
    setUnreadCount((c) => Math.max(0, c - 1));
  };

  const markAllRead = async () => {
    if (!user) return;
    await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .is('read_at', null);
    setNotifications((prev) =>
      prev.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() }))
    );
    setUnreadCount(0);
  };

  const timeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  const notifIcon = (type: string) => {
    if (type.includes('approved')) return 'Approved';
    if (type.includes('denied')) return 'Denied';
    if (type.includes('paid')) return 'Paid';
    if (type.includes('submitted') || type.includes('review')) return 'Review';
    if (type.includes('invoice')) return 'Invoice';
    if (type.includes('schedule')) return 'Schedule';
    return '';
  };

  const handleSwitchUser = async () => {
    if (!switchEmail.trim() || !switchPassword.trim()) return;
    setSwitching(true);
    setSwitchError('');
    await supabase.auth.signOut();
    const { error } = await supabase.auth.signInWithPassword({
      email: switchEmail.trim(),
      password: switchPassword.trim(),
    });
    if (error) {
      setSwitchError(error.message);
      setSwitching(false);
      return;
    }
    window.location.href = '/home';
  };

  const subtitle = clockStatus === 'in'
    ? 'Clocked In'
    : clockStatus === 'break'
    ? 'On Break'
    : activePartNumber
    ? `${activePartNumber} • ${activeEndCustomer}`
    : '';

  // Switch user modal overlay
  if (showSwitchModal) {
    return (
      <>
        <header style={{
          background: theme.headerBg, padding: '12px 20px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          position: 'sticky', top: 0, zIndex: 100,
          borderBottom: `1px solid ${theme.border}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ height: '36px', padding: '4px 10px', borderRadius: '10px', background: 'rgba(255,255,255,0.08)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,0.06)' }}>
              <img src="/bmg-logo-white.png" alt="BMG" style={{ height: '26px', width: 'auto' }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).parentElement!.innerHTML = '<span style="font-weight:800;font-size:11px;color:white;letter-spacing:1px">BMG</span>'; }} />
            </div>
          </div>
        </header>
        <div style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}
          onClick={() => { setShowSwitchModal(false); setSwitchError(''); }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: 'var(--card)', borderRadius: '16px', padding: '24px', width: '100%', maxWidth: '360px',
            border: '1px solid var(--border)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '4px' }}>Switch User</div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px' }}>Sign in as a different account</div>

            {switchError && (
              <div style={{ padding: '10px', borderRadius: '8px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontSize: '12px', fontWeight: 600, marginBottom: '12px' }}>
                {switchError}
              </div>
            )}

            <div style={{ marginBottom: '10px' }}>
              <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Email</label>
              <input type="email" value={switchEmail} onChange={(e) => setSwitchEmail(e.target.value)} placeholder="user@example.com"
                style={{ width: '100%', padding: '12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '14px' }}
                autoFocus />
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Password</label>
              <input type="password" value={switchPassword} onChange={(e) => setSwitchPassword(e.target.value)} placeholder="••••••••"
                style={{ width: '100%', padding: '12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '14px' }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSwitchUser(); }} />
            </div>

            <button onClick={handleSwitchUser} disabled={switching || !switchEmail.trim() || !switchPassword.trim()} style={{
              width: '100%', padding: '14px', borderRadius: '12px', background: 'var(--navy)', color: '#fff',
              fontWeight: 800, fontSize: '14px', border: 'none', marginBottom: '8px',
              opacity: switching || !switchEmail.trim() || !switchPassword.trim() ? 0.4 : 1,
            }}>{switching ? 'Signing in...' : 'Switch Account'}</button>

            <button onClick={() => { setShowSwitchModal(false); setSwitchError(''); setSwitchEmail(''); setSwitchPassword(''); }} style={{
              width: '100%', padding: '10px', borderRadius: '10px', border: '1px solid var(--border)',
              background: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 700,
            }}>Cancel</button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <header style={{
        background: theme.headerBg, padding: '12px 20px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        position: 'sticky', top: 0, zIndex: 100,
        borderBottom: `1px solid ${theme.border}`,
      }}>
        <div
          onClick={() => router.push('/home')}
          style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}
        >
          <div style={{
            height: '36px', padding: '4px 10px', borderRadius: '10px',
            background: 'rgba(255,255,255,0.08)', backdropFilter: 'blur(10px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '1px solid rgba(255,255,255,0.06)',
          }}>
            <img src="/bmg-logo-white.png" alt="BMG" style={{ height: '26px', width: 'auto' }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).parentElement!.innerHTML = '<span style="font-weight:800;font-size:11px;color:white;letter-spacing:1px">BMG</span>'; }} />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '12px', fontWeight: 800, color: '#fff', letterSpacing: '0.3px' }}>
                {isAdmin ? 'FleetSuite' : 'Fleet GO'}
              </span>
              <span style={{
                background: isAdmin ? theme.orangeGlow : 'rgba(255,255,255,0.1)',
                border: `1px solid ${isAdmin ? 'rgba(238,49,32,0.3)' : 'rgba(255,255,255,0.15)'}`,
                borderRadius: '5px',
                color: isAdmin ? '#ff9e94' : 'rgba(255,255,255,0.7)',
                padding: '2px 7px', fontSize: '9px', fontWeight: 700, letterSpacing: '0.3px',
              }}>
                {isAdmin ? 'Admin' : 'Crew'}
              </span>
            </div>
            {subtitle && (
              <div style={{ fontSize: '10px', color: theme.textMuted, marginTop: '2px' }}>{subtitle}</div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {/* Universal Search */}
          <button
            onClick={() => setShowSearch(true)}
            style={{
              background: 'transparent',
              border: '1px solid transparent', borderRadius: '8px',
              padding: '6px 8px', fontSize: '16px',
              cursor: 'pointer', transition: 'all 0.15s',
              lineHeight: 1,
            }}
          >
            Search
          </button>

          {/* Chat / Messages */}
          <button
            onClick={() => router.push('/messages')}
            style={{
              background: 'transparent',
              border: '1px solid transparent', borderRadius: '8px',
              padding: '6px 8px', fontSize: '16px', position: 'relative',
              cursor: 'pointer', transition: 'all 0.15s',
              lineHeight: 1,
            }}
          >
            Chat
            {unreadMessages > 0 && (
              <span style={{
                position: 'absolute', top: '2px', right: '2px',
                background: '#3b82f6', color: '#fff',
                fontSize: '9px', fontWeight: 800,
                minWidth: '16px', height: '16px',
                borderRadius: '8px', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                padding: '0 4px',
                boxShadow: '0 2px 6px rgba(59,130,246,0.4)',
              }}>
                {unreadMessages > 99 ? '99+' : unreadMessages}
              </span>
            )}
          </button>

          {/* Notification bell */}
          <div ref={notifRef} style={{ position: 'relative' }}>
            <button onClick={handleBellClick} style={{
              background: showNotifications ? 'rgba(255,255,255,0.12)' : 'transparent',
              border: '1px solid transparent', borderRadius: '8px',
              padding: '6px 8px', fontSize: '16px', position: 'relative',
              cursor: 'pointer', transition: 'all 0.15s',
              lineHeight: 1,
            }}>
              Alerts
              {unreadCount > 0 && (
                <span style={{
                  position: 'absolute', top: '2px', right: '2px',
                  background: '#ef4444', color: '#fff',
                  fontSize: '9px', fontWeight: 800,
                  minWidth: '16px', height: '16px',
                  borderRadius: '8px', display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                  padding: '0 4px',
                  boxShadow: '0 2px 6px rgba(239,68,68,0.4)',
                }}>
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>

            {/* Notifications dropdown */}
            {showNotifications && (
              <div style={{
                position: 'absolute', top: '100%', right: 0, marginTop: '6px',
                background: 'var(--card)', border: '1px solid var(--border)',
                borderRadius: '14px', boxShadow: '0 12px 40px rgba(0,0,0,0.3)',
                width: '320px', maxHeight: '440px', display: 'flex', flexDirection: 'column',
                zIndex: 160, overflow: 'hidden',
              }}>
                {/* Header */}
                <div style={{
                  padding: '12px 14px', borderBottom: '1px solid var(--border)',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  flexShrink: 0,
                }}>
                  <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>
                    Notifications
                    {unreadCount > 0 && (
                      <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--orange)', marginLeft: '6px' }}>
                        {unreadCount} new
                      </span>
                    )}
                  </div>
                  {unreadCount > 0 && (
                    <button onClick={markAllRead} style={{
                      background: 'none', border: 'none', fontSize: '11px',
                      fontWeight: 700, color: 'var(--navy-light)', cursor: 'pointer',
                      padding: '4px 8px', borderRadius: '6px',
                    }}>
                      Mark all read
                    </button>
                  )}
                </div>

                {/* Notification list */}
                <div style={{ overflowY: 'auto', flex: 1 }}>
                  {loadingNotifs ? (
                    <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading...</div>
                  ) : notifications.length === 0 ? (
                    <div style={{ padding: '32px 16px', textAlign: 'center' }}>
                      <div style={{ fontSize: '28px', opacity: 0.3, marginBottom: '6px' }}></div>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-muted)' }}>No notifications yet</div>
                    </div>
                  ) : (
                    notifications.map((n) => {
                      const isUnread = !n.read_at;
                      const hasLink = !!n.url;
                      return (
                        <button
                          key={n.id}
                          onClick={() => {
                            if (isUnread) markAsRead(n.id);
                            if (hasLink) {
                              setShowNotifications(false);
                              router.push(n.url!);
                            }
                          }}
                          style={{
                            width: '100%', textAlign: 'left', padding: '12px 14px',
                            background: isUnread ? 'rgba(238,49,32,0.03)' : 'transparent',
                            borderBottom: '1px solid var(--border)', border: 'none',
                            borderLeft: isUnread ? '3px solid var(--orange)' : '3px solid transparent',
                            cursor: (isUnread || hasLink) ? 'pointer' : 'default',
                            transition: 'background 0.15s',
                            display: 'flex', gap: '10px', alignItems: 'start',
                          }}
                        >
                          <div style={{ fontSize: '16px', flexShrink: 0, marginTop: '1px' }}>
                            {notifIcon(n.type)}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                              fontSize: '13px', fontWeight: isUnread ? 700 : 600,
                              color: isUnread ? 'var(--text-primary)' : 'var(--text-secondary)',
                              lineHeight: 1.3,
                            }}>
                              {n.title}
                            </div>
                            <div style={{
                              fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px',
                              lineHeight: 1.3,
                              overflow: 'hidden', textOverflow: 'ellipsis',
                              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any,
                            }}>
                              {n.body}
                            </div>
                            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '3px', opacity: 0.7 }}>
                              {timeAgo(n.created_at)}
                            </div>
                          </div>
                          {isUnread && (
                            <div style={{
                              width: '8px', height: '8px', borderRadius: '50%',
                              background: 'var(--orange)', flexShrink: 0, marginTop: '4px',
                            }} />
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          {/* User menu */}
          <div ref={menuRef} style={{ position: 'relative' }}>
            <button onClick={() => { setShowMenu(!showMenu); setShowNotifications(false); }} style={{
              background: showMenu ? 'rgba(255,255,255,0.12)' : 'transparent',
              border: '1px solid transparent', borderRadius: '8px',
              padding: '6px 10px', fontSize: '12px', color: theme.textMuted,
              fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px',
              transition: 'all 0.15s',
            }}>
              {profile?.full_name}
              <span style={{ fontSize: '8px', opacity: 0.6 }}>▼</span>
            </button>

            {showMenu && (
              <div style={{
                position: 'absolute', top: '100%', right: 0, marginTop: '6px',
                background: 'var(--card)', border: '1px solid var(--border)',
                borderRadius: '12px', boxShadow: '0 8px 30px rgba(0,0,0,0.25)',
                overflow: 'hidden', minWidth: '180px', zIndex: 150,
              }}>
                <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{profile?.full_name}</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{profile?.email}</div>
                  <div style={{ fontSize: '10px', color: isAdmin ? 'var(--orange)' : 'var(--navy-light)', marginTop: '2px', fontWeight: 600 }}>
                    {isAdmin ? 'Administrator' : 'Installer'}
                  </div>
                </div>

                <button onClick={() => { setShowMenu(false); setShowSwitchModal(true); setSwitchEmail(''); setSwitchPassword(''); setSwitchError(''); }} style={{
                  width: '100%', padding: '12px 14px', textAlign: 'left', background: 'transparent',
                  border: 'none', borderBottom: '1px solid var(--border)',
                  fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)',
                  display: 'flex', alignItems: 'center', gap: '8px',
                }}>
                  Switch User
                </button>

                <button onClick={() => { setShowMenu(false); signOut(); }} style={{
                  width: '100%', padding: '12px 14px', textAlign: 'left', background: 'transparent',
                  border: 'none', fontSize: '13px', fontWeight: 600, color: 'var(--error)',
                  display: 'flex', alignItems: 'center', gap: '8px',
                }}>
                  Sign Out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <UniversalSearch open={showSearch} onClose={() => setShowSearch(false)} />
    </>
  );
}
