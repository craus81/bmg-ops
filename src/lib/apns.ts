import { createSign } from 'node:crypto';
import http2 from 'node:http2';

/**
 * Minimal APNs (Apple Push Notification service) HTTP/2 provider.
 *
 * Sends alert pushes to the native iOS/iPadOS app using token-based (p8)
 * authentication — no Firebase middleman. Env:
 *   APNS_TEAM_ID      Apple Developer Team ID (10 chars)
 *   APNS_KEY_ID       Key ID of the APNs Auth Key (10 chars)
 *   APNS_PRIVATE_KEY  Contents of the .p8 file (\n-escaped or literal newlines)
 *   APNS_BUNDLE_ID    App bundle id (defaults to com.bmgfleet.fleetsuite)
 *
 * Xcode "development" builds get sandbox tokens while TestFlight/App Store
 * builds get production ones — send() tries production first and retries the
 * sandbox host when APNs answers BadDeviceToken, so both build types work
 * without configuration.
 */

const b64url = (input: Buffer | string) =>
  (typeof input === 'string' ? Buffer.from(input) : input)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function apnsConfigured(): boolean {
  return !!(process.env.APNS_TEAM_ID && process.env.APNS_KEY_ID && process.env.APNS_PRIVATE_KEY);
}

/**
 * Build an APNs provider JWT (ES256, ieee-p1363 signature as JOSE requires).
 * Exported for tests — production callers go through the cached providerJwt().
 */
export function createProviderJwt(privateKeyPem: string, keyId: string, teamId: string, iat?: number): string {
  const now = iat ?? Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: now }));
  const signer = createSign('SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign({ key: privateKeyPem, dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${b64url(signature)}`;
}

// APNs provider JWTs are valid 20–60 minutes; cache and refresh at 45.
let cachedJwt: { token: string; issuedAt: number } | null = null;
function providerJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && now - cachedJwt.issuedAt < 45 * 60) return cachedJwt.token;
  const privateKey = (process.env.APNS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const token = createProviderJwt(privateKey, process.env.APNS_KEY_ID || '', process.env.APNS_TEAM_ID || '', now);
  cachedJwt = { token, issuedAt: now };
  return token;
}

function postToApns(host: string, deviceToken: string, body: string): Promise<{ status: number; reason?: string }> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${host}`);
    client.on('error', reject);
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'authorization': `bearer ${providerJwt()}`,
      'apns-topic': process.env.APNS_BUNDLE_ID || 'com.bmgfleet.fleetsuite',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });
    let status = 0;
    let data = '';
    req.on('response', (headers) => { status = Number(headers[':status']) || 0; });
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      client.close();
      let reason: string | undefined;
      try { reason = JSON.parse(data)?.reason; } catch {}
      resolve({ status, reason });
    });
    req.on('error', (err) => { client.close(); reject(err); });
    req.setTimeout(10_000, () => { req.close(); client.close(); reject(new Error('APNs request timed out')); });
    req.end(body);
  });
}

/**
 * Send one alert push. Returns:
 *   'sent'  — delivered to APNs
 *   'stale' — APNs says this token is dead; caller should delete it
 *   'error' — transient/config failure; keep the token
 */
export async function sendApnsNotification(
  deviceToken: string,
  payload: { title: string; body: string; url?: string },
): Promise<'sent' | 'stale' | 'error'> {
  if (!apnsConfigured()) return 'error';

  const body = JSON.stringify({
    aps: { alert: { title: payload.title, body: payload.body }, sound: 'default' },
    ...(payload.url ? { url: payload.url } : {}),
  });

  try {
    let res = await postToApns('api.push.apple.com', deviceToken, body);
    // Dev (Xcode) builds register sandbox tokens — retry there.
    if (res.status === 400 && res.reason === 'BadDeviceToken') {
      res = await postToApns('api.sandbox.push.apple.com', deviceToken, body);
    }
    if (res.status === 200) return 'sent';
    if (res.status === 410 || res.reason === 'BadDeviceToken' || res.reason === 'Unregistered') return 'stale';
    console.error('APNs send failed:', res.status, res.reason);
    return 'error';
  } catch (err: any) {
    console.error('APNs send error:', err?.message);
    return 'error';
  }
}
