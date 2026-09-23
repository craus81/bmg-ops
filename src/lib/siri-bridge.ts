import { apiFetch } from '@/lib/api-client';

/**
 * Web side of the iPhone app's Siri key (src/lib/siri-keys.ts). The Siri
 * intent runs without the web view, so after sign-in this mints a key for the
 * device and hands it to the native SiriKey plugin
 * (ios/App/App/SiriKeyPlugin.swift), which keeps it in the Keychain; sign-out
 * revokes it. Everything here is a no-op on the web and on app builds that
 * predate the plugin (the calls reject and are swallowed).
 */

interface SiriKeyPlugin {
  saveKey(options: { key: string; keyId: string; userId: string }): Promise<void>;
  clearKey(): Promise<void>;
  keyStatus(): Promise<{ hasKey: boolean; keyId?: string; userId?: string }>;
}

// Wrapped in an object on purpose: a Capacitor plugin proxy answers every
// property, `then` included, so resolving a promise with the bare proxy would
// treat it as a thenable and call a native "then" method.
let plugin: Promise<{ native: SiriKeyPlugin } | null> | null = null;

function siriKeyPlugin(): Promise<{ native: SiriKeyPlugin } | null> {
  plugin ??= (async () => {
    try {
      const { Capacitor, registerPlugin } = await import('@capacitor/core');
      return Capacitor.isNativePlatform() ? { native: registerPlugin<SiriKeyPlugin>('SiriKey') } : null;
    } catch {
      return null;
    }
  })();
  return plugin;
}

// Bumped by every sign-out. A key setup already in flight must not store its
// key after one, or the signed-out user's key would stay on the phone. Checking
// right before saveKey is enough: JS is single-threaded and the plugin runs
// calls in the order they're made, so a save sent first is cleared by the
// sign-out that follows it.
let generation = 0;

/** Make sure this device holds a Siri key for `userId`, minting one if not. */
export async function ensureSiriKey(userId: string): Promise<void> {
  const native = (await siriKeyPlugin())?.native;
  if (!native) return;
  const started = generation;
  try {
    const status = await native.keyStatus();
    if (status.hasKey && status.userId === userId) return;
    const res = await apiFetch('/api/siri/key', { method: 'POST' });
    if (!res.ok) return;
    const { key, keyId } = await res.json();
    // Signed out meanwhile: drop it. A key nothing holds can't be used.
    if (started !== generation) return;
    await native.saveKey({ key, keyId, userId });
  } catch (err) {
    console.warn('Siri key setup skipped:', err);
  }
}

/** Forget and revoke this device's Siri key. Call while still signed in. */
export async function forgetSiriKey(): Promise<void> {
  generation++;
  const native = (await siriKeyPlugin())?.native;
  if (!native) return;
  try {
    const status = await native.keyStatus();
    // Off the phone first: that alone makes the key unusable, so the server
    // revoke after it is a backstop and sign-out waits on it only briefly.
    await native.clearKey();
    if (status.hasKey && status.keyId) {
      const revoke = apiFetch('/api/siri/key', {
        method: 'DELETE',
        body: JSON.stringify({ keyId: status.keyId }),
      }).catch(() => {});
      await Promise.race([revoke, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
  } catch (err) {
    console.warn('Siri key cleanup skipped:', err);
  }
}
