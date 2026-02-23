'use client';

import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';

interface HeaderProps {
  clockStatus: 'out' | 'in' | 'break';
  activePartNumber?: string;
  activeEndCustomer?: string;
}

export default function Header({ clockStatus, activePartNumber, activeEndCustomer }: HeaderProps) {
  const { profile, isAdmin, signOut } = useAuth();
  const [showMenu, setShowMenu] = useState(false);
  const [showSwitchModal, setShowSwitchModal] = useState(false);
  const [switchEmail, setSwitchEmail] = useState('');
  const [switchPassword, setSwitchPassword] = useState('');
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const { createClient } = require('@/lib/supabase-browser');
  const supabase = createClient();

  // Close menu on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    if (showMenu) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showMenu]);

  const handleSwitchUser = async () => {
    if (!switchEmail.trim() || !switchPassword.trim()) return;
    setSwitching(true);
    setSwitchError('');

    // Sign out current user first
    await supabase.auth.signOut();

    // Sign in as new user
    const { error } = await supabase.auth.signInWithPassword({
      email: switchEmail.trim(),
      password: switchPassword.trim(),
    });

    if (error) {
      setSwitchError(error.message);
      setSwitching(false);
      return;
    }

    // Reload the page to reinitialize everything
    window.location.href = '/home';
  };

  const subtitle = clockStatus === 'in'
    ? '🟢 Clocked In'
    : clockStatus === 'break'
    ? '🟡 On Break'
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
    <header style={{
      background: theme.headerBg, padding: '12px 20px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      position: 'sticky', top: 0, zIndex: 100,
      borderBottom: `1px solid ${theme.border}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
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

      {/* Tappable name with dropdown */}
      <div ref={menuRef} style={{ position: 'relative' }}>
        <button onClick={() => setShowMenu(!showMenu)} style={{
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
            {/* Current user info */}
            <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{profile?.full_name}</div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{profile?.email}</div>
              <div style={{ fontSize: '10px', color: isAdmin ? 'var(--orange)' : 'var(--navy-light)', marginTop: '2px', fontWeight: 600 }}>
                {isAdmin ? 'Administrator' : 'Installer'}
              </div>
            </div>

            {/* Switch User */}
            <button onClick={() => { setShowMenu(false); setShowSwitchModal(true); setSwitchEmail(''); setSwitchPassword(''); setSwitchError(''); }} style={{
              width: '100%', padding: '12px 14px', textAlign: 'left', background: 'transparent',
              border: 'none', borderBottom: '1px solid var(--border)',
              fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)',
              display: 'flex', alignItems: 'center', gap: '8px',
            }}>
              🔄 Switch User
            </button>

            {/* Sign Out */}
            <button onClick={() => { setShowMenu(false); signOut(); }} style={{
              width: '100%', padding: '12px 14px', textAlign: 'left', background: 'transparent',
              border: 'none', fontSize: '13px', fontWeight: 600, color: 'var(--error)',
              display: 'flex', alignItems: 'center', gap: '8px',
            }}>
              🚪 Sign Out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
