import { describe, expect, it } from 'vitest';
import { createHmac } from 'crypto';
import { verifyDropboxSignature } from './client-files-lease';

const secret = 'app-secret';
const body = '{"list_folder":{"accounts":["dbid:abc"]},"delta":{"users":[1]}}';
const sign = (b: string, s = secret) => createHmac('sha256', s).update(b).digest('hex');

describe('verifyDropboxSignature', () => {
  it('accepts the signature Dropbox sends', () => {
    expect(verifyDropboxSignature(body, sign(body), secret)).toBe(true);
  });

  it('rejects a changed body or another secret', () => {
    expect(verifyDropboxSignature(body + ' ', sign(body), secret)).toBe(false);
    expect(verifyDropboxSignature(body, sign(body, 'other'), secret)).toBe(false);
  });

  it('fails closed with no signature, no secret, or junk', () => {
    expect(verifyDropboxSignature(body, null, secret)).toBe(false);
    expect(verifyDropboxSignature(body, sign(body), undefined)).toBe(false);
    expect(verifyDropboxSignature(body, sign(body), '')).toBe(false);
    expect(verifyDropboxSignature(body, 'abc', secret)).toBe(false);
  });
});
