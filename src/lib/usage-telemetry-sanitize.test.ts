import { describe, it, expect } from 'vitest';
import {
  templateRoute, isTemplatedPage, maskPii, cleanStack, describeRejection,
  sanitizeDetail, sanitizeEvent, uaFamily, VIN_RE, MAX_DETAIL_BYTES, MAX_PAGE_CHARS, utf8Bytes, jsonBytes,
} from './usage-telemetry-sanitize';

/**
 * The scrubbers run on BOTH sides of the beacon (browser before enqueue,
 * route before insert). Every rule here is a promise the table comment
 * makes about what is deliberately not stored.
 */

describe('templateRoute — credential segments', () => {
  it('the /book/[token] segment is the estimate-approval token', () => {
    expect(templateRoute('/book/8f3a9c1e-2b4d-4c6e-9f0a-1b2c3d4e5f60')).toBe('/book/:token');
    expect(templateRoute('/book/abc.DEF-123')).toBe('/book/:token');
    expect(templateRoute('/api/book/8f3a9c1e-2b4d-4c6e-9f0a-1b2c3d4e5f60')).toBe('/api/book/:token');
  });
  it('portal, approve/<kind>, cni/schedule, signed/<type> — with and without /api', () => {
    expect(templateRoute('/portal/tok123/billing')).toBe('/portal/:token/billing');
    expect(templateRoute('/api/portal/tok123/ask')).toBe('/api/portal/:token/ask');
    expect(templateRoute('/approve/estimate/tok123')).toBe('/approve/estimate/:token');
    expect(templateRoute('/api/approve/proof/tok123')).toBe('/api/approve/proof/:token');
    expect(templateRoute('/cni/schedule/tok123')).toBe('/cni/schedule/:token');
    expect(templateRoute('/api/cni/schedule/tok123.ics')).toBe('/api/cni/schedule/:token');
    expect(templateRoute('/signed/estimate/tok123')).toBe('/signed/estimate/:token');
  });
  it('a uuid-shaped token is :token, not :id', () => {
    expect(templateRoute('/portal/8f3a9c1e-2b4d-4c6e-9f0a-1b2c3d4e5f60')).toBe('/portal/:token');
  });
});

describe('templateRoute — vehicles by position', () => {
  it('a real-looking 17-char VIN under /vehicles/', () => {
    expect(templateRoute('/vehicles/1FTBW3XM5PKA00001/pick-list')).toBe('/vehicles/:vin/pick-list');
    expect(templateRoute('/api/vehicles/1FTBW3XM5PKA00001')).toBe('/api/vehicles/:vin');
  });
  it('segment names compare case-insensitively — a hand-typed /Vehicles/<vin> still reaches the beacon as typed', () => {
    expect(templateRoute('/Vehicles/1FTBW3XM5PKA00001')).toBe('/Vehicles/:vin');
    expect(templateRoute('/Book/8f3a9c1e-2b4d-4c6e-9f0a-1b2c3d4e5f60')).toBe('/Book/:token');
    expect(templateRoute('/API/Approve/Estimate/tok123')).toBe('/api/Approve/Estimate/:token'); // prefix normalised, rest kept as typed
    expect(templateRoute('/api/Approve/Estimate/tok123')).toBe('/api/Approve/Estimate/:token');
  });
  it('anything in that position is a VIN, whatever it looks like', () => {
    expect(templateRoute('/vehicles/short')).toBe('/vehicles/:vin');
  });
});

describe('templateRoute — ids, query, hash', () => {
  it('uuid segments → :id', () => {
    expect(templateRoute('/admin/pos/8f3a9c1e-2b4d-4c6e-9f0a-1b2c3d4e5f60')).toBe('/admin/pos/:id');
    expect(templateRoute('/api/estimates/8F3A9C1E-2B4D-4C6E-9F0A-1B2C3D4E5F60/send')).toBe('/api/estimates/:id/send');
  });
  it('all-digit segments → :id', () => {
    expect(templateRoute('/graphics/12345')).toBe('/graphics/:id');
    expect(templateRoute('/api/netsuite/items/7')).toBe('/api/netsuite/items/:id');
  });
  it('strips query string and hash always', () => {
    expect(templateRoute('/tracking?vehicle=abc&email=x@y.com#top')).toBe('/tracking');
    expect(templateRoute('/estimates#section')).toBe('/estimates');
    expect(templateRoute('https://ops.bmgfleet.com/admin/inbox?thread=t-1')).toBe('/admin/inbox');
  });
  it('mixed-case words and hyphenated slugs are left alone', () => {
    expect(templateRoute('/admin/cni/jobs/new')).toBe('/admin/cni/jobs/new');
  });
  it('never throws on junk', () => {
    expect(templateRoute(undefined)).toBe('/');
    expect(templateRoute('')).toBe('/');
    expect(templateRoute(42)).toBe('/');
  });
  it('isTemplatedPage flags record pages so the report renders them as text', () => {
    expect(isTemplatedPage('/vehicles/:vin')).toBe(true);
    expect(isTemplatedPage('/book/:token')).toBe(true);
    expect(isTemplatedPage('/admin/pos/:id')).toBe(true);
    expect(isTemplatedPage('/tracking')).toBe(false);
  });
});

describe('maskPii', () => {
  it('emails', () => {
    expect(maskPii('mail to bob.smith+x@example.co.uk failed')).toBe('mail to [email] failed');
  });
  it('phones', () => {
    expect(maskPii('call (555) 123-4567 or 555.123.4567 or 5551234567')).toBe('call [phone] or [phone] or [phone]');
  });
  it('digit runs of 4+', () => {
    expect(maskPii('SO 12345 line 3 qty 999')).toBe('SO [n] line 3 qty 999');
  });
  it('VINs, case-insensitive, 11–17 chars with a digit', () => {
    expect(maskPii('vin 1FTBW3XM5PKA00001 missing')).toBe('vin [vin] missing');
    expect(maskPii('vin 1ftbw3xm5pka00001 missing')).toBe('vin [vin] missing');
    expect(maskPii('partial 3XM5PKA00001')).toBe('partial [vin]');
    // Pure words of 11+ letters are not VINs.
    expect(maskPii('Unauthorized')).toBe('Unauthorized');
    expect('ABCDEFGHIJK'.match(VIN_RE)).toBeNull();
  });
  it('quoted segments', () => {
    expect(maskPii('column "customer_email" is bad')).toBe('column "[…]" is bad');
    expect(maskPii("can't find 'Acme Fleet'")).toMatch(/"\[…\]"/);
    expect(maskPii('said “hello there”')).toBe('said "[…]"');
  });
  it('parenthesised groups', () => {
    expect(maskPii('Cannot read (reading x) now')).toBe('Cannot read (…) now');
  });
  it('Postgres Key (…)=(…) shape', () => {
    expect(maskPii('duplicate key value violates unique constraint "x" DETAIL: Key (email)=(a@b.com) already exists.'))
      .toBe('duplicate key value violates unique constraint "[…]" DETAIL: Key (…)=(…) already exists.');
  });
  it('long unhyphenated hex — the 64-char customer_portal_token shape VIN_RE cannot reach', () => {
    const tok = '8f3a9c1e2b4d4c6e9f0a1b2c3d4e5f608f3a9c1e2b4d4c6e9f0a1b2c3d4e5f60';
    const out = maskPii(`bad token ${tok}`);
    expect(out).toBe('bad token [hex]');
    expect(out).not.toContain('8f3a9c1e');
    expect(maskPii(`token=${tok.slice(0, 32)}`)).toBe('token=[hex]');
    expect(maskPii('deadbeef0123456789ab')).toBe('[hex]'); // 20 is the floor
    expect(maskPii('build abc123def4567')).toBe('build [vin]'); // shorter runs stay with the VIN/serial rule
  });
  it('backtick-quoted fragments are masked like any other quote style', () => {
    expect(maskPii('Customer `Acme Trucking LLC` not found')).toBe('Customer "[…]" not found');
  });
  it('uuids anywhere in text — the shape of every e-sign token — leave no hex behind', () => {
    const token = '8f3a1b2c-4d5e-4f70-8a9b-0c1d2e3f4a5b';
    const out = maskPii(`Failed to load /api/book/${token}`);
    expect(out).toBe('Failed to load /api/book/[uuid]');
    expect(out).not.toMatch(/[0-9a-f]{4,}/i);
    expect(maskPii(`token ${token.toUpperCase()} rejected`)).toBe('token [uuid] rejected');
  });
  it('non-strings become empty', () => {
    expect(maskPii(undefined)).toBe('');
    expect(maskPii({ a: 1 })).toBe('');
  });
});

describe('cleanStack', () => {
  it('keeps at most 5 path:line:col frames with origin and query removed', () => {
    const stack = [
      'TypeError: x is not a function',
      '    at foo (https://ops.bmgfleet.com/_next/static/chunks/app.js?v=abc:12:34)',
      '    at bar (https://ops.bmgfleet.com/_next/static/chunks/app.js:56:7)',
      '    at a (/x.js:1:1)', '    at b (/x.js:2:2)', '    at c (/x.js:3:3)', '    at d (/x.js:4:4)',
    ].join('\n');
    const out = cleanStack(stack)!;
    expect(out.split('\n')).toHaveLength(5);
    expect(out).toContain('/_next/static/chunks/app.js:12:34');
    expect(out).not.toContain('ops.bmgfleet.com');
    expect(out).not.toContain('v=abc');
  });
  it('a document-url frame on /book/<token> is templated, V8 style', () => {
    const token = '8f3a1b2c-4d5e-4f70-8a9b-0c1d2e3f4a5b';
    const out = cleanStack(`TypeError: boom\n    at https://ops.bmgfleet.com/book/${token}:1:2345`)!;
    expect(out).toBe('/book/:token:1:[n]');
    expect(out).not.toMatch(/[0-9a-f]{8}/i);
  });
  it('a document-url frame on /book/<token> is templated, Firefox style', () => {
    const token = '8f3a1b2c-4d5e-4f70-8a9b-0c1d2e3f4a5b';
    const out = cleanStack(`onClick@https://ops.bmgfleet.com/book/${token}?x=1:7:12\n@https://ops.bmgfleet.com/_next/static/chunks/app.js:9:8`)!;
    expect(out.split('\n')).toEqual(['/book/:token:7:12', '/_next/static/chunks/app.js:9:8']);
    expect(out).not.toContain(token.slice(0, 8));
  });
  it('a 64-hex portal token in a frame or a message never survives', () => {
    const tok = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';
    const stack = `Error: bad token ${tok}\n    at https://ops.bmgfleet.com/portal/${tok}/billing:1:2`;
    const out = cleanStack(stack)!;
    expect(out).toContain('/portal/:token/billing:1:2');
    expect(out).not.toContain('0123456789abcdef');
    expect(cleanStack(`    at token ${tok} in handler`)!).not.toContain('0123456789abcdef');
  });
  it('a uuid in a frame the location regex cannot parse is still masked', () => {
    const token = '8f3a1b2c-4d5e-4f70-8a9b-0c1d2e3f4a5b';
    const out = cleanStack(`Error: x\n    at approve ${token} <anonymous>`)!;
    expect(out).toContain('[uuid]');
    expect(out).not.toContain(token.slice(0, 8));
  });
  it('undefined for empty input', () => {
    expect(cleanStack('')).toBeUndefined();
    expect(cleanStack(undefined)).toBeUndefined();
  });
});

describe('describeRejection', () => {
  it('non-Error reasons record only the type, never content', () => {
    expect(describeRejection({ message: 'row 12345 bob@x.com', code: '23505' }).message).toBe('non-Error rejection (object)');
    expect(describeRejection('secret text').message).toBe('non-Error rejection (string)');
    expect(describeRejection(undefined).message).toBe('non-Error rejection (undefined)');
    expect(describeRejection(42)).toEqual({ message: 'non-Error rejection (number)' });
  });
  it('Response reasons include the status only', () => {
    expect(describeRejection(new Response('body', { status: 503 })).message).toBe('non-Error rejection (object Response 503)');
  });
  it('Error reasons with structured messages are dropped', () => {
    expect(describeRejection(new Error('{"error":"x"}')).message).toBe('structured message dropped');
    expect(describeRejection(new Error('  [1,2,3]')).message).toBe('structured message dropped');
    expect(describeRejection(new Error('<html>')).message).toBe('structured message dropped');
  });
  it('plain Error messages are masked', () => {
    expect(describeRejection(new Error('Failed for bob@x.com')).message).toBe('Failed for [email]');
  });
});

describe('sanitizeDetail / sanitizeEvent', () => {
  it('drops value-like and unknown keys per kind', () => {
    const d = sanitizeDetail('form_abandon', {
      attempt_id: '8f3a9c1e-2b4d-4c6e-9f0a-1b2c3d4e5f60', seconds_open: 12.6, fields_touched: 3, step: 1, exit: 'close',
      value: 'secret', values: ['x'], fields: { email: 'a@b' }, body: 'x', payload: {},
    });
    expect(d).toEqual({ attempt_id: '8f3a9c1e-2b4d-4c6e-9f0a-1b2c3d4e5f60', seconds_open: 13, fields_touched: 3, step: 1, exit: 'close' });
  });
  it('masks and templates strings inside detail', () => {
    const d = sanitizeDetail('api_slow', { route: '/api/vehicles/1FTBW3XM5PKA00001?x=1', method: 'post', ms: 5000, status: 500, failed: false });
    expect(d).toEqual({ route: '/api/vehicles/:vin', method: 'POST', ms: 5000, status: 500, failed: false });
    const e = sanitizeDetail('error', { message: 'user bob@x.com broke SO 12345', source: 'https://x/a.js?q=1', line: 3, col: 4, extra: 'no' });
    expect(e).toEqual({ message: 'user [email] broke SO [n]', source: '/a.js', line: 3, col: 4 });
  });
  it('rejects unknown kinds and form events without a form id', () => {
    expect(sanitizeEvent({ kind: 'click', page: '/x' })).toBeNull();
    expect(sanitizeEvent({ kind: 'form_start', page: '/x' })).toBeNull();
    expect(sanitizeEvent({ kind: 'form_start', page: '/x', form_id: 'Bad Id!' })).toBeNull();
  });
  it('page and error.source are masked after templating, and re-bounded to the column width', () => {
    expect(sanitizeEvent({ kind: 'error', page: '/search/bob@x.com' })!.page).toBe('/search/[email]');
    expect(sanitizeEvent({ kind: 'error', page: '/tracking/1FTBW3XM5PKA00001' })!.page).toBe('/tracking/[vin]');
    expect(sanitizeDetail('error', { source: 'https://ops.bmgfleet.com/search/bob@x.com?q=1' }).source).toBe('/search/[email]');
    // masking can lengthen a string: 40 emails of 7 chars → 40 × '[email]' = 280 chars; the CHECK is 200
    const long = '/' + Array(40).fill('a@b.cd').join('/');
    const page = sanitizeEvent({ kind: 'error', page: long })!.page;
    expect(page.length).toBeLessThanOrEqual(MAX_PAGE_CHARS);
    expect(page).not.toContain('a@b.cd');
  });
  it('utf8Bytes / jsonBytes count bytes, not UTF-16 units', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('…')).toBe(3);
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('😀')).toBe(4);
    expect(jsonBytes({ m: '…' })).toBe(utf8Bytes('{"m":"…"}'));
  });
  it('templates the page and caps detail at 4 KB', () => {
    const ev = sanitizeEvent({ kind: 'error', page: '/book/tok?x=1', detail: { message: 'x'.repeat(10) } })!;
    expect(ev.page).toBe('/book/:token');
    const big = sanitizeEvent({ kind: 'error', page: '/x', detail: { message: 'y'.repeat(100), stack: Array(400).fill('at /a.js:1:1').join('\n') } })!;
    expect(JSON.stringify(big.detail).length).toBeLessThanOrEqual(MAX_DETAIL_BYTES);
  });
});

describe('uaFamily', () => {
  it('classifies without keeping the string', () => {
    expect(uaFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148')).toBe('ios-webview');
    expect(uaFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe('ios-safari');
    expect(uaFamily('Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36')).toBe('android-webview');
    expect(uaFamily('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36')).toBe('android-chrome');
    expect(uaFamily('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36')).toBe('desktop');
    expect(uaFamily('')).toBe('other');
    expect(uaFamily('curl/8.0')).toBe('other');
  });
});
