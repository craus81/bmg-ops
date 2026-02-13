'use client';

import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';

export default function MorePage() {
  const router = useRouter();
  const { isAdmin, profile, signOut } = useAuth();

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: '#4a5f78', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
        More
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <MenuBtn icon="📊" title="Export Reports" sub="Download vehicle spreadsheets" onClick={() => router.push('/reports')} />
        {isAdmin && (
          <>
            <MenuBtn icon="📦" title="Part Catalog" sub="Manage part numbers" onClick={() => router.push('/admin/catalog')} />
            <MenuBtn icon="📋" title="Purchase Orders" sub="Manage POs" onClick={() => router.push('/admin/pos')} />
          </>
        )}
        <MenuBtn icon="📝" title="Quick Job (No PO)" sub="Start scanning without a PO" onClick={() => router.push('/scan')} />
      </div>

      <div style={{ marginTop: '32px', padding: '14px', background: '#141e2b', border: '1px solid #1e2d3d', borderRadius: '10px' }}>
        <div style={{ fontSize: '13px', fontWeight: 700 }}>{profile?.full_name}</div>
        <div style={{ fontSize: '11px', color: '#4a5f78', marginTop: '2px' }}>{profile?.email}</div>
        <div style={{ fontSize: '11px', color: isAdmin ? '#a78bfa' : '#60a5fa', marginTop: '2px', fontWeight: 600 }}>
          {isAdmin ? 'Administrator' : 'Installer'}
        </div>
        <button
          onClick={signOut}
          style={{
            marginTop: '12px', width: '100%', padding: '10px', borderRadius: '8px',
            border: '1px solid rgba(239,68,68,0.25)', background: 'rgba(239,68,68,0.05)',
            color: '#f87171', fontSize: '13px', fontWeight: 700,
          }}
        >
          Sign Out
        </button>
      </div>
    </div>
  );
}

function MenuBtn({ icon, title, sub, onClick }: { icon: string; title: string; sub: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: '12px', width: '100%',
        padding: '12px', borderRadius: '10px', textAlign: 'left',
        border: '1px solid #1e2d3d', background: '#141e2b', color: '#e8ecf1',
      }}
    >
      <div style={{
        width: '38px', height: '38px', borderRadius: '8px',
        background: 'rgba(255,255,255,0.03)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', fontSize: '17px', flexShrink: 0,
      }}>{icon}</div>
      <div>
        <div style={{ fontWeight: 700, fontSize: '14px' }}>{title}</div>
        <div style={{ fontSize: '11px', color: '#4a5f78', marginTop: '1px' }}>{sub}</div>
      </div>
    </button>
  );
}
