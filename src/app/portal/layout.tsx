// Public customer PO-status portal — outside the (main) route group on
// purpose, so it never mounts ClientProviders/AuthProvider: the shared
// link's token is the only credential (see src/app/api/portal/[token]).
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
