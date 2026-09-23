'use client';

import { useEffect } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { ensureSiriKey } from '@/lib/siri-bridge';

/**
 * iPhone app only: once someone who can use the Schedule is signed in, give
 * this device a Siri key so "add a calendar entry in BMG FleetSuite" can save
 * without opening the app (src/lib/siri-bridge.ts). No-op on the web.
 */
export default function NativeSiriKey() {
  const { user, hasFeature, loading } = useAuth();
  const canSchedule = !loading && hasFeature('schedule');

  useEffect(() => {
    if (user?.id && canSchedule) ensureSiriKey(user.id);
  }, [user?.id, canSchedule]);

  return null;
}
