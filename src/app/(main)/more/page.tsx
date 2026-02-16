'use client';

import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';

export default function MorePage() {
  const router = useRouter();
  const { isAdmin, profile, signOut } = useAuth();

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>
        More
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <MenuBtn icon="📊" title="Export Reports" sub="Download vehicle spreadsheets" onClick={() => router.push('/reports')} />
        {isAdmin && (<>
          <MenuBtn icon="📦" title="Part Catalog" sub="Manage part numbers" onClick={() => router.push('/admin/catalog')} />
          <MenuBtn icon="📋" title="Purchase Orders" sub="Manage POs" onClick={() => router.push('/admin/pos')} />
        </>)}
        <MenuBtn icon="📝" title="Quick Job (No PO)" sub="Start scanning without a PO" onClick={() => router.push('/scan')} />
      </div>

      <div style={{ marginTop: '32px', padding: '16px', background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px', boxShadow: theme.shadowSm }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: theme.textPrimary }}>{profile?.full_name}</div>
        <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '3px' }}>{profile?.email}</div>
        <div style={{ fontSize: '11px', color: isAdmin ? theme.orange : theme.navyLight, marginTop: '3px', fontWeight: 600 }}>
          {isAdmin ? 'Administrator' : 'Installer'}
        </div>
        <button onClick={signOut} style={{
          marginTop: '14px', width: '100%', padding: '12px', borderRadius: '10px',
          border: `1px solid ${theme.errorBorder}`, background: theme.errorBg,
          color: theme.error, fontSize: '13px', fontWeight: 700,
        }}>Sign Out</button>
      </div>
    </div>
  );
}

function MenuBtn({ icon, title, sub, onClick }: { icon: string; title: string; sub: string; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: '14px', width: '100%',
      padding: '16px', borderRadius: '14px', textAlign: 'left',
      border: `1px solid ${theme.border}`, background: theme.card,
      boxShadow: theme.shadowSm, transition: 'all 0.15s',
    }}>
      <div style={{
        width: '44px', height: '44px', borderRadius: '12px',
        background: 'rgba(255,255,255,0.03)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', fontSize: '20px', flexShrink: 0,
      }}>{icon}</div>
      <div>
        <div style={{ fontWeight: 700, fontSize: '15px', color: theme.textPrimary, letterSpacing: '-0.2px' }}>{title}</div>
        <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '2px' }}>{sub}</div>
      </div>
    </button>
  );
}
