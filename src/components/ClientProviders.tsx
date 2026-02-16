'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '@/components/AuthProvider';
import { AppProvider, useApp } from '@/components/AppProvider';
import Header from '@/components/Header';
import BottomNav from '@/components/BottomNav';
import { theme } from '@/lib/theme';

function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { clockStatus, activePart, appLoading } = useApp();

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [loading, user]);

  if (loading || appLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: theme.pageBg }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width: '36px', height: '36px', border: `3px solid ${theme.gray200}`,
            borderTopColor: theme.orange, borderRadius: '50%', margin: '0 auto',
            animation: 'spin 1s linear infinite',
          }} />
          <div style={{ color: theme.gray500, marginTop: '12px', fontSize: '13px', fontWeight: 600 }}>Loading...</div>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div style={{ minHeight: '100vh', paddingBottom: '70px', background: theme.pageBg }}>
      <Header
        clockStatus={clockStatus}
        activePartNumber={activePart?.part_number}
        activeEndCustomer={activePart?.end_customer}
      />
      <div style={{ maxWidth: '500px', margin: '0 auto', padding: '14px 20px' }}>
        {children}
      </div>
      <BottomNav clockStatus={clockStatus} />
    </div>
  );
}

export default function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AppProvider>
        <AppShell>{children}</AppShell>
      </AppProvider>
    </AuthProvider>
  );
}
