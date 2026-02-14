'use client';

import { AuthProvider, useAuth } from '@/components/AuthProvider';

function AuthTest({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ color: 'white', textAlign: 'center', marginTop: '50px' }}>
        <h1>Auth Loading...</h1>
        <p>Waiting for AuthProvider to resolve</p>
      </div>
    );
  }

  return (
    <div>
      <h1 style={{ color: 'white', textAlign: 'center', marginTop: '50px' }}>
        Auth loaded! User: {user?.email || 'none'}
      </h1>
      {children}
    </div>
  );
}

export default function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AuthTest>{children}</AuthTest>
    </AuthProvider>
  );
}
