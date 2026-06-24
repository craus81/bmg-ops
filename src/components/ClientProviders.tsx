'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '@/components/AuthProvider';
import { AppProvider, useApp } from '@/components/AppProvider';
import { ThemeProvider } from '@/components/ThemeProvider';
import { PopoutProvider } from '@/components/Popout';
import { DialogProvider } from '@/components/DialogProvider';
import Header from '@/components/Header';
import BottomNav from '@/components/BottomNav';
import AiChat from '@/components/AiChat';
import DeepLinkHandler from '@/components/DeepLinkHandler';

function PendingScreen() {
  const { signOut } = useAuth();
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: '20px' }}>
      <div style={{ textAlign: 'center', maxWidth: '340px' }}>
        <div style={{ fontSize: '20px', marginBottom: '12px', color: 'var(--text-muted)' }}>Pending</div>
        <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '8px' }}>Waiting for Approval</div>
        <div style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: '1.5', marginBottom: '24px' }}>
          Your account has been created but hasn&apos;t been approved yet. An admin will review your request shortly.
        </div>
        <button onClick={() => window.location.reload()} style={{
          padding: '12px 24px', borderRadius: '12px', background: 'var(--navy)',
          color: '#fff', fontSize: '14px', fontWeight: 700, border: 'none',
          marginBottom: '10px', width: '100%',
        }}>Check Again</button>
        <button onClick={signOut} style={{
          padding: '12px 24px', borderRadius: '12px', background: 'transparent',
          color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600,
          border: '1px solid var(--border)', width: '100%',
        }}>Sign Out</button>
      </div>
    </div>
  );
}

function DeniedScreen() {
  const { signOut } = useAuth();
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: '20px' }}>
      <div style={{ textAlign: 'center', maxWidth: '340px' }}>
        <div style={{ fontSize: '20px', marginBottom: '12px', color: 'var(--text-muted)' }}>Denied</div>
        <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '8px' }}>Access Denied</div>
        <div style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: '1.5', marginBottom: '24px' }}>
          Your account request was not approved. Contact an admin if you believe this is a mistake.
        </div>
        <button onClick={signOut} style={{
          padding: '12px 24px', borderRadius: '12px', background: 'transparent',
          color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600,
          border: '1px solid var(--border)', width: '100%',
        }}>Sign Out</button>
      </div>
    </div>
  );
}

function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, loading, profile } = useAuth();
  const { clockStatus, activePart, appLoading } = useApp();

  useEffect(() => {
    if (!loading && !user) {
      // Preserve the destination across login so deep links from emails
      // (e.g. /graphics?id=...) land where the user expected.
      const here = window.location.pathname + window.location.search + window.location.hash;
      const next = here && here !== '/' && here !== '/login' ? `?next=${encodeURIComponent(here)}` : '';
      router.push(`/login${next}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [loading, user]);

  if (loading || appLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width: '36px', height: '36px', border: '3px solid var(--border)',
            borderTopColor: 'var(--orange)', borderRadius: '50%', margin: '0 auto',
            animation: 'spin 1s linear infinite',
          }} />
          <div style={{ color: 'var(--text-muted)', marginTop: '12px', fontSize: '13px', fontWeight: 600 }}>Loading...</div>
        </div>
      </div>
    );
  }

  if (!user) return null;

  // Check approval status
  if (profile?.status === 'pending') return <PendingScreen />;
  if (profile?.status === 'denied') return <DeniedScreen />;

  return (
    <div style={{ minHeight: '100vh', paddingBottom: '85px', background: 'var(--bg)' }}>
      <Header clockStatus={clockStatus} activePartNumber={activePart?.part_number} activeEndCustomer={activePart?.end_customer} />
      <main id="main" style={{ maxWidth: '1200px', margin: '0 auto', padding: '14px 20px', boxSizing: 'border-box' }}>
        {children}
      </main>
      <BottomNav clockStatus={clockStatus} />
      <AiChat />
    </div>
  );
}

export default function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppProvider>
          <PopoutProvider>
            <DialogProvider>
              <DeepLinkHandler />
              <AppShell>{children}</AppShell>
            </DialogProvider>
          </PopoutProvider>
        </AppProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
