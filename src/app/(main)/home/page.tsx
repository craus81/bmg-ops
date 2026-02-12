'use client';

import { useRouter } from 'next/navigation';
import { useApp } from '@/components/AppProvider';
import { useAuth } from '@/components/AuthProvider';

export default function HomePage() {
  const router = useRouter();
  const { clockStatus, activePart } = useApp();
  const { isAdmin } = useAuth();

  return (
    <div>
      {clockStatus === 'out' && (
        <button
          onClick={() => router.push('/time')}
          style={{
            width: '100%', padding: '12px 16px', borderRadius: '10px', marginBottom: '12px',
            background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.25)',
            color: '#fbbf24', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
            textAlign: 'left', display: 'flex', alignItems: 'center', gap: '8px',
          }}
        >
          ⏰ Not clocked in — tap to start your day
        </button>
      )}

      {activePart && (
        <div style={{
          background: 'linear-gradient(135deg, rgba(59,130,246,0.10), rgba(59,130,246,0.03))',
          border: '1px solid rgba(59,130,246,0.25)', borderRadius: '14px',
          padding: '14px', marginBottom: '12px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
            <div>
              <div style={{ fontSize: '10px', color: '#60a5fa', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Active Part Number</div>
              <div style={{ fontWeight: 800, fontSize: '18px', marginTop: '2px' }}>{activePart.part_number}</div>
              <div style={{ fontSize: '12px', color: '#8899aa', marginTop: '1px' }}>{activePart.end_customer} • {activePart.graphic_package}</div>
              <div style={{ fontSize: '11px', color: '#4a5f78', marginTop: '1px' }}>{activePart.vehicle_type} • {activePart.customer}</div>
            </div>
            <button
              onClick={() => router.push('/select-part')}
              style={{
                background: 'rgba(255,255,255,0.05)', border: '1px solid #1e2d3d',
                borderRadius: '8px', color: '#6b7a8d', padding: '4px 10px',
                fontSize: '10px', fontWeight: 700,
              }}
            >
              Change
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <BigBtn
          icon="📷" title="Scan VIN"
          sub={activePart ? `${activePart.part_number} — ${activePart.end_customer}` : 'Select a part number first'}
          onClick={() => router.push('/scan')}
          primary
          disabled={!activePart}
        />
        <BigBtn
          icon="🔧" title="Set Active Part Number"
          sub={activePart ? 'Change what you\'re installing' : 'Choose before scanning'}
          onClick={() => router.push('/select-part')}
          highlight={!activePart}
        />
      </div>
    </div>
  );
}

function BigBtn({ icon, title, sub, onClick, primary, highlight, disabled }: {
  icon: string; title: string; sub?: string; onClick: () => void;
  primary?: boolean; highlight?: boolean; disabled?: boolean;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: '12px', width: '100%',
        padding: '12px', borderRadius: '10px', cursor: disabled ? 'default' : 'pointer',
        textAlign: 'left',
        border: primary ? '1px solid rgba(59,130,246,0.3)' : highlight ? '1px solid rgba(245,158,11,0.3)' : '1px solid #1e2d3d',
        background: primary ? 'rgba(59,130,246,0.05)' : highlight ? 'rgba(245,158,11,0.03)' : '#141e2b',
        color: '#e8ecf1', opacity: disabled ? 0.4 : 1,
      }}
    >
      <div style={{
        width: '38px', height: '38px', borderRadius: '8px',
        background: primary ? 'rgba(59,130,246,0.1)' : 'rgba(255,255,255,0.03)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '17px', flexShrink: 0,
      }}>{icon}</div>
      <div>
        <div style={{ fontWeight: 700, fontSize: '14px' }}>{title}</div>
        {sub && <div style={{ fontSize: '11px', color: '#4a5f78', marginTop: '1px' }}>{sub}</div>}
      </div>
    </button>
  );
}
