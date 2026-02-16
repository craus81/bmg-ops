'use client';

import { useRouter } from 'next/navigation';
import { useApp } from '@/components/AppProvider';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';

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
            background: theme.warningBg, border: `1px solid ${theme.warningBorder}`,
            color: theme.warning, fontSize: '13px', fontWeight: 700, cursor: 'pointer',
            textAlign: 'left', display: 'flex', alignItems: 'center', gap: '8px',
          }}
        >
          ⏰ Not clocked in — tap to start your day
        </button>
      )}

      {activePart && (
        <div style={{
          background: theme.white,
          border: `1px solid ${theme.cardBorder}`,
          borderRadius: '14px', padding: '14px', marginBottom: '12px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
            <div>
              <div style={{ fontSize: '10px', color: theme.orange, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Active Part Number</div>
              <div style={{ fontWeight: 800, fontSize: '18px', color: theme.gray800, marginTop: '2px' }}>{activePart.part_number}</div>
              <div style={{ fontSize: '12px', color: theme.gray500, marginTop: '1px' }}>{activePart.end_customer} • {activePart.graphic_package}</div>
              <div style={{ fontSize: '11px', color: theme.gray400, marginTop: '1px' }}>{activePart.vehicle_type} • {activePart.customer}</div>
            </div>
            <button
              onClick={() => router.push('/select-part')}
              style={{
                background: theme.gray50, border: `1px solid ${theme.gray200}`,
                borderRadius: '8px', color: theme.gray500, padding: '4px 10px',
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
        padding: '14px', borderRadius: '12px', cursor: disabled ? 'default' : 'pointer',
        textAlign: 'left',
        border: primary ? `1px solid rgba(238,49,32,0.25)` : highlight ? `1px solid ${theme.warningBorder}` : `1px solid ${theme.cardBorder}`,
        background: primary ? 'rgba(238,49,32,0.04)' : highlight ? theme.warningBg : theme.white,
        color: theme.gray700, opacity: disabled ? 0.4 : 1,
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        transition: 'box-shadow 0.15s',
      }}
    >
      <div style={{
        width: '40px', height: '40px', borderRadius: '10px',
        background: primary ? 'rgba(238,49,32,0.08)' : theme.gray50,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '18px', flexShrink: 0,
      }}>{icon}</div>
      <div>
        <div style={{ fontWeight: 700, fontSize: '14px', color: theme.gray800 }}>{title}</div>
        {sub && <div style={{ fontSize: '11px', color: theme.gray400, marginTop: '2px' }}>{sub}</div>}
      </div>
    </button>
  );
}
