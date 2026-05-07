import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { validateBody, validateSearchParams, z } from './validate';

function makeRequest(url: string, init?: RequestInit) {
  return new NextRequest(new Request(url, init));
}

describe('validateSearchParams', () => {
  const Schema = z.object({
    customerId: z.string().regex(/^\d+$/),
    q: z.string().max(10).optional(),
  });

  it('returns typed data for valid params', () => {
    const req = makeRequest('http://x/api?customerId=42&q=hello');
    const out = validateSearchParams(req, Schema);
    expect(out.error).toBeUndefined();
    expect(out.data).toEqual({ customerId: '42', q: 'hello' });
  });

  it('returns 400 when required field is missing', async () => {
    const req = makeRequest('http://x/api?q=hello');
    const out = validateSearchParams(req, Schema);
    expect(out.error).toBeDefined();
    expect(out.error!.status).toBe(400);
    const body = await out.error!.json();
    expect(body.error).toBe('Invalid request');
    expect(Array.isArray(body.details)).toBe(true);
  });

  it('returns 400 when field fails regex', () => {
    const req = makeRequest('http://x/api?customerId=abc');
    const out = validateSearchParams(req, Schema);
    expect(out.error?.status).toBe(400);
  });
});

describe('validateBody', () => {
  const Schema = z.object({ name: z.string().min(1), age: z.number().int().nonnegative() });

  it('returns typed data for valid JSON', async () => {
    const req = makeRequest('http://x/api', {
      method: 'POST',
      body: JSON.stringify({ name: 'Alice', age: 30 }),
      headers: { 'content-type': 'application/json' },
    });
    const out = await validateBody(req, Schema);
    expect(out.error).toBeUndefined();
    expect(out.data).toEqual({ name: 'Alice', age: 30 });
  });

  it('returns 400 for invalid JSON', async () => {
    const req = makeRequest('http://x/api', {
      method: 'POST',
      body: 'not json',
      headers: { 'content-type': 'application/json' },
    });
    const out = await validateBody(req, Schema);
    expect(out.error?.status).toBe(400);
    const body = await out.error!.json();
    expect(body.error).toBe('Invalid JSON body');
  });

  it('returns 400 with field details for schema violations', async () => {
    const req = makeRequest('http://x/api', {
      method: 'POST',
      body: JSON.stringify({ name: '', age: -1 }),
      headers: { 'content-type': 'application/json' },
    });
    const out = await validateBody(req, Schema);
    expect(out.error?.status).toBe(400);
    const body = await out.error!.json();
    expect(body.details.length).toBeGreaterThanOrEqual(2);
  });
});
