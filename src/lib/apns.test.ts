import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createProviderJwt, sendApnsNotification, apnsConfigured } from './apns';

const b64urlDecode = (s: string) =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

describe('createProviderJwt', () => {
  it('produces a valid ES256 JWT that verifies against the public key', () => {
    // Same curve/format as an Apple .p8 APNs auth key.
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    const jwt = createProviderJwt(privateKey, 'KEY1234567', 'TEAM123456', 1_700_000_000);
    const [header, claims, signature] = jwt.split('.');

    expect(JSON.parse(b64urlDecode(header).toString())).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(JSON.parse(b64urlDecode(claims).toString())).toEqual({ iss: 'TEAM123456', iat: 1_700_000_000 });

    // JOSE ES256 signatures are raw r||s (ieee-p1363), 64 bytes for P-256.
    const sigBytes = b64urlDecode(signature);
    expect(sigBytes.length).toBe(64);

    const verifier = createVerify('SHA256');
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, sigBytes)).toBe(true);
  });
});

describe('sendApnsNotification', () => {
  it('reports error (not stale) when APNs is unconfigured, so tokens are kept', async () => {
    expect(apnsConfigured()).toBe(false);
    const result = await sendApnsNotification('abc123def456abc1', { title: 't', body: 'b' });
    expect(result).toBe('error');
  });
});
