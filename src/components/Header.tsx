'use client';

import { useAuth } from '@/components/AuthProvider';

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
      background: '#141e2b', borderBottom: '1px solid #1e2d3d',
      padding: '12px 20px', display: 'flex', alignItems: 'center',
      justifyContent: 'space-between', position: 'sticky', top: 0, zIndex: 100,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{
          width: '32px', height: '32px', borderRadius: '8px',
          background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 800, fontSize: '11px', color: '#fff',
        }}>BMG</div>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontWeight: 700, fontSize: '14px' }}>BMG Ops</span>
            <span style={{
              background: isAdmin ? 'rgba(139,92,246,0.12)' : 'rgba(59,130,246,0.12)',
              border: `1px solid ${isAdmin ? 'rgba(139,92,246,0.3)' : 'rgba(59,130,246,0.3)'}`,
              borderRadius: '5px', color: isAdmin ? '#a78bfa' : '#60a5fa',
              padding: '2px 6px', fontSize: '9px', fontWeight: 700,
            }}>
              {isAdmin ? 'Admin' : 'Crew'}
            </span>
          </div>
          {subtitle && (
            <div style={{ fontSize: '10px', color: '#4a5f78' }}>{subtitle}</div>
          )}
        </div>
      </div>
      <div style={{ fontSize: '11px', color: '#4a5f78' }}>
        {profile?.full_name}
      </div>
    </header>
  );
}
