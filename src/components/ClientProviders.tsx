'use client';

export default function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <h1 style={{ color: 'white', textAlign: 'center', marginTop: '50px' }}>
        BMG Ops is working!
      </h1>
      {children}
    </div>
  );
}
