'use client';

/**
 * Client-side Web Push subscription utilities.
 *
 * Handles:
 * - Requesting notification permission from the browser
 * - Subscribing to push via the service worker's pushManager
 * - Sending the subscription to the server for storage
 * - Unsubscribing and cleaning up
 */

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';

/** Convert a base64 VAPID public key to a Uint8Array for the Push API */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/** Check if push notifications are supported in this browser */
export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Get the current notification permission state */
export function getPushPermission(): NotificationPermission | 'unsupported' {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission;
}

/** Check if the user currently has an active push subscription */
export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Subscribe to push notifications.
 * Requests permission if needed, subscribes via service worker, and sends to server.
 */
export async function subscribeToPush(): Promise<{ ok: boolean; error?: string }> {
  if (!isPushSupported()) {
    return { ok: false, error: 'Push notifications are not supported in this browser.' };
  }

  if (!VAPID_PUBLIC_KEY) {
    return { ok: false, error: 'Push notification configuration is missing.' };
  }

  try {
    // Request permission
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return { ok: false, error: 'Notification permission was denied. Check your browser settings.' };
    }

    // Wait for service worker to be ready
    const registration = await navigator.serviceWorker.ready;

    // Subscribe to push
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    });

    // Send subscription to our server
    const response = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return { ok: false, error: data.error || 'Failed to save subscription on server.' };
    }

    return { ok: true };
  } catch (err: any) {
    console.error('subscribeToPush error:', err);
    return { ok: false, error: err.message || 'Failed to subscribe.' };
  }
}

/**
 * Unsubscribe from push notifications.
 * Removes the subscription from the browser and server.
 */
export async function unsubscribeFromPush(): Promise<{ ok: boolean; error?: string }> {
  try {
    const subscription = await getExistingSubscription();
    if (!subscription) {
      return { ok: true }; // Already unsubscribed
    }

    const endpoint = subscription.endpoint;

    // Unsubscribe from the browser
    await subscription.unsubscribe();

    // Remove from server
    await fetch('/api/push/subscribe', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });

    return { ok: true };
  } catch (err: any) {
    console.error('unsubscribeFromPush error:', err);
    return { ok: false, error: err.message || 'Failed to unsubscribe.' };
  }
}
