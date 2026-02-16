'use client';

import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';

interface HeaderProps {
  clockStatus: 'out' | 'in' | 'break';
  activePartNumber?: string;
  activeEndCustomer?: string;
}

export default function Header({ clockStatus, activePartNumber, activeEndCustomer }: HeaderProps) {
  const { profile, isAdmin } = useAuth();

  const subtitle = clockStatus === 'in'
    ? '🟢 Clocked In'
    : clockStatus === 'break'
    ? '🟡 On Break'
    : activePartNumber
    ? `${activePartNumber} • ${activeEndCustomer}`
    : '';

  return (
    <header style={{
      background: theme.headerBg,
      padding: '12px 20px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      position: 'sticky', top: 0, zIndex: 100,
      borderBottom: `1px solid ${theme.border}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{
          height: '36px', padding: '4px 10px', borderRadius: '10px',
          background: 'rgba(255,255,255,0.08)',
          backdropFilter: 'blur(10px)',
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
      <div style={{ fontSize: '12px', color: theme.textMuted, fontWeight: 500 }}>
        {profile?.full_name}
      </div>
    </header>
  );
}
