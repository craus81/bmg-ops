// Public shared-photos page — outside the (main) route group on purpose, so
// it never mounts ClientProviders/AuthProvider: the link's token is the only
// credential (see src/lib/photo-shares.ts).
export default function SharedPhotosLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
