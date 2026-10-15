import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'QC fixes · BMG Fleet',
  robots: { index: false, follow: false },
};

// A customer's QC fix link — outside the (main) route group on purpose, so it
// never mounts ClientProviders/AuthProvider: the link's token is the only
// credential (see src/app/api/qc/[token]).
export default function QcLinkLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
