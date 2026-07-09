'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';

/**
 * Registers the native iOS/iPadOS app for APNs push and routes notification
 * taps to their deep link.
 *
 * Runs only on the Capacitor native platform (no-op on the web, where push is
 * handled by the service worker / push-client.ts). On login it requests
 * permission, registers with APNs, and posts the device token to
 * /api/push/register-native so lib/notify can reach this device.
 */
export default function NativePushHandler() {
  const router = useRouter();
  const { user } = useAuth();
  const registeredFor = useRef<string | null>(null);

  useEffect(() => {
    if (!user || registeredFor.current === user.id) return;
    let cancelled = false;
    const listeners: { remove: () => void }[] = [];

    (async () => {
      try {
        const cap = await import('@capacitor/core');
        if (!cap.Capacitor?.isNativePlatform?.()) return;
        const { PushNotifications } = await import('@capacitor/push-notifications');

        // Token arrives via this listener after register().
        const reg = await PushNotifications.addListener('registration', async (token) => {
          try {
            await fetch('/api/push/register-native', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: token.value, platform: 'ios' }),
            });
          } catch (e) {
            console.error('NativePushHandler: token upload failed', e);
          }
        });
        listeners.push(reg);

        const regErr = await PushNotifications.addListener('registrationError', (err) => {
          console.error('NativePushHandler: APNs registration error', err);
        });
        listeners.push(regErr);

        // Tapping a notification opens its deep link (same-origin paths only).
        const tap = await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
          const url = action?.notification?.data?.url;
          if (typeof url === 'string' && url.startsWith('/')) router.push(url);
        });
        listeners.push(tap);

        let perm = await PushNotifications.checkPermissions();
        if (perm.receive === 'prompt') {
          perm = await PushNotifications.requestPermissions();
        }
        if (perm.receive !== 'granted' || cancelled) return;

        await PushNotifications.register();
        registeredFor.current = user.id;
      } catch (e) {
        // Plugin unavailable (old binary) or not native — nothing to do.
        console.warn('NativePushHandler unavailable:', e);
      }
    })();

    return () => {
      cancelled = true;
      listeners.forEach((l) => l.remove());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- register once per signed-in user
  }, [user?.id]);

  return null;
}
