'use client';

import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';

export default function MorePage() {
  const router = useRouter();
  const { isAdmin, profile, signOut } = useAuth();

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: theme.gray500, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
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

      <div style={{ marginTop: '32px', padding: '14px', background: theme.white, border: `1px solid ${theme.cardBorder}`, borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: theme.gray800 }}>{profile?.full_name}</div>
        <div style={{ fontSize: '11px', color: theme.gray500, marginTop: '2px' }}>{profile?.email}</div>
        <div style={{ fontSize: '11px', color: isAdmin ? theme.orange : theme.navy, marginTop: '2px', fontWeight: 600 }}>
          {isAdmin ? 'Administrator' : 'Installer'}
        </div>
        <button
          onClick={signOut}
          style={{
            marginTop: '12px', width: '100%', padding: '10px', borderRadius: '8px',
            border: `1px solid ${theme.errorBorder}`, background: theme.errorBg,
            color: theme.error, fontSize: '13px', fontWeight: 700,
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
        padding: '14px', borderRadius: '12px', textAlign: 'left',
        border: `1px solid ${theme.cardBorder}`, background: theme.white, color: theme.gray800,
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      }}
    >
      <div style={{
        width: '40px', height: '40px', borderRadius: '10px',
        background: theme.gray50, display: 'flex',
        alignItems: 'center', justifyContent: 'center', fontSize: '18px', flexShrink: 0,
      }}>{icon}</div>
      <div>
        <div style={{ fontWeight: 700, fontSize: '14px' }}>{title}</div>
        <div style={{ fontSize: '11px', color: theme.gray500, marginTop: '2px' }}>{sub}</div>
      </div>
    </button>
  );
}
