import UsageTelemetry from '@/components/UsageTelemetry';

/**
 * Public credit-application form — no AuthProvider on purpose. The usage
 * beacon mounts here so an abandoned application shows up on System
 * Health → Usage (anonymous rows; the server only accepts this page's
 * events from a caller with no session).
 */
export default function CreditApplicationLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <UsageTelemetry />
      {children}
    </>
  );
}
