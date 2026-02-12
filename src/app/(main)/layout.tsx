'use client';

import { useAuth } from '@/components/AuthProvider';
import { AppProvider, useApp } from '@/components/AppProvider';
import Header from '@/components/Header';
import BottomNav from '@/components/BottomNav';

function AppShell({ children }: { children: React.ReactNode }) {
  const { loading } = useAuth();
  const { clockStatus, activePart, appLoading } = useApp();

  if (loading || appLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            width: '36px', height: '36px', border: '3px solid #1e2d3d',
            borderTopColor: '#3b82f6', borderRadius: '50%', margin: '0 auto',
            animation: 'spin 1s linear infinite',
          }} />
          <div style={{ color: '#4a5f78', marginTop: '12px', fontSize: '13px' }}>Loading...</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', paddingBottom: '70px' }}>
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

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider>
      <AppShell>{children}</AppShell>
    </AppProvider>
  );
}
