// Public customer Order status page — outside the (main) route group on
// purpose, so it never mounts ClientProviders/AuthProvider: the link's token
// is the only credential (see src/app/api/order-status/[token]).
export default function OrderStatusLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
