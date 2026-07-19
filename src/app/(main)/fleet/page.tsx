'use client';

/**
 * Check-In merged into the In-Shop page — "Check In Vehicle" is now the
 * top section of /tracking (the wizard itself lives in
 * src/components/VehicleCheckIn.tsx). This route survives as a redirect so
 * bookmarks and muscle memory keep working; ?checkin=1 auto-opens the
 * check-in panel on arrival.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function FleetRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/tracking?checkin=1'); }, [router]);
  return (
    <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
      Check-in now lives on the In-Shop page — taking you there…
    </div>
  );
}
