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
      background: theme.navy,
      padding: '12px 20px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      position: 'sticky', top: 0, zIndex: 100,
      boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        {/* BMG Logo mark */}
        <div style={{
          width: '34px', height: '34px', borderRadius: '8px',
          background: 'rgba(255,255,255,0.12)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 900, fontSize: '11px', color: '#fff',
          letterSpacing: '0.5px',
        }}>
          <img src="/bmg-logo-mark.png" alt="BMG" style={{ width: '26px', height: '26px', objectFit: 'contain' }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).parentElement!.textContent = 'BMG'; }} />
        </div>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontWeight: 700, fontSize: '15px', color: '#fff' }}>BMG Ops</span>
            <span style={{
              background: isAdmin ? 'rgba(238,49,32,0.2)' : 'rgba(255,255,255,0.15)',
              border: `1px solid ${isAdmin ? 'rgba(238,49,32,0.4)' : 'rgba(255,255,255,0.25)'}`,
              borderRadius: '5px',
              color: isAdmin ? '#ffb4ae' : 'rgba(255,255,255,0.8)',
              padding: '2px 6px', fontSize: '9px', fontWeight: 700,
            }}>
              {isAdmin ? 'Admin' : 'Crew'}
            </span>
          </div>
          {subtitle && (
            <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.55)' }}>{subtitle}</div>
          )}
        </div>
      </div>
      <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.65)', fontWeight: 600 }}>
        {profile?.full_name}
      </div>
    </header>
  );
}
