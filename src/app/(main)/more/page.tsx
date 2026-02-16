'use client';

import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useTheme } from '@/components/ThemeProvider';

export default function MorePage() {
  const router = useRouter();
  const { isAdmin, profile, signOut } = useAuth();
  const { mode, setMode, resolvedTheme } = useTheme();

  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px' }}>
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

      {/* Theme Toggle */}
      <div style={{ marginTop: '24px' }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '10px' }}>
          Appearance
        </div>
        <div style={{
          display: 'flex', gap: '4px', padding: '4px',
          background: 'var(--card)', border: '1px solid var(--border)',
          borderRadius: '14px', boxShadow: 'var(--shadow-sm)',
        }}>
          {([
            { id: 'auto' as const, label: '🔄 Auto', desc: 'System' },
            { id: 'light' as const, label: '☀️ Light', desc: '' },
            { id: 'dark' as const, label: '🌙 Dark', desc: '' },
          ]).map((opt) => (
            <button
              key={opt.id}
              onClick={() => setMode(opt.id)}
              style={{
                flex: 1, padding: '10px 6px', borderRadius: '10px',
                fontSize: '12px', fontWeight: 700,
                background: mode === opt.id ? 'var(--tab-active-bg)' : 'transparent',
                border: mode === opt.id ? '1px solid var(--tab-active-border)' : '1px solid transparent',
                color: mode === opt.id ? 'var(--text-primary)' : 'var(--text-muted)',
                transition: 'all 0.15s',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {mode === 'auto' && (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px', textAlign: 'center' }}>
            Currently showing {resolvedTheme} (matches your device)
          </div>
        )}
      </div>

      {/* Profile */}
      <div style={{ marginTop: '24px', padding: '16px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', boxShadow: 'var(--shadow-sm)' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>{profile?.full_name}</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px' }}>{profile?.email}</div>
        <div style={{ fontSize: '11px', color: isAdmin ? 'var(--orange)' : 'var(--navy-light)', marginTop: '3px', fontWeight: 600 }}>
          {isAdmin ? 'Administrator' : 'Installer'}
        </div>
        <button onClick={signOut} style={{
          marginTop: '14px', width: '100%', padding: '12px', borderRadius: '10px',
          border: '1px solid var(--error-border)', background: 'var(--error-bg)',
          color: 'var(--error)', fontSize: '13px', fontWeight: 700,
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
      border: '1px solid var(--border)', background: 'var(--card)',
      boxShadow: 'var(--shadow-sm)', transition: 'all 0.15s',
    }}>
      <div style={{
        width: '44px', height: '44px', borderRadius: '12px',
        background: 'var(--subtle-bg)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', fontSize: '20px', flexShrink: 0,
      }}>{icon}</div>
      <div>
        <div style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)', letterSpacing: '-0.2px' }}>{title}</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>{sub}</div>
      </div>
    </button>
  );
}
