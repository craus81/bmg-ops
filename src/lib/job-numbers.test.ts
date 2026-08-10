import { describe, it, expect } from 'vitest';
import { nextJobNumber, legacyJobNumber } from './job-numbers';

// The RPC failing must never block a save — pin the fallback contract.
const rpcOk = (value: unknown) => ({ rpc: async () => ({ data: value, error: null }) }) as any;
const rpcErr = () => ({ rpc: async () => ({ data: null, error: { message: 'function does not exist' } }) }) as any;
const rpcThrows = () => ({ rpc: async () => { throw new Error('network down'); } }) as any;

describe('nextJobNumber', () => {
  it('returns the sequence number when the RPC works', async () => {
    expect(await nextJobNumber(rpcOk('EST-2608-041'), 'EST', () => 'FALLBACK')).toBe('EST-2608-041');
  });

  it('falls back to the legacy format on RPC error', async () => {
    expect(await nextJobNumber(rpcErr(), 'EST', () => 'FALLBACK')).toBe('FALLBACK');
  });

  it('falls back when the RPC throws (offline, migration not applied)', async () => {
    expect(await nextJobNumber(rpcThrows(), 'GFX', () => 'FALLBACK')).toBe('FALLBACK');
  });

  it('falls back on an empty or non-string payload', async () => {
    expect(await nextJobNumber(rpcOk(''), 'WQ', () => 'FALLBACK')).toBe('FALLBACK');
    expect(await nextJobNumber(rpcOk(null), 'WQ', () => 'FALLBACK')).toBe('FALLBACK');
  });
});

describe('legacyJobNumber (fallback formats keep the old shapes)', () => {
  it('est: EST-YYMM-XXXX', () => {
    expect(legacyJobNumber.est()).toMatch(/^EST-\d{4}-[A-Z0-9]{4}$/);
  });
  it('gfx: prefix + base36 + random suffix', () => {
    expect(legacyJobNumber.gfx()).toMatch(/^GFX-[A-Z0-9]+-[A-Z0-9]{3}$/);
    expect(legacyJobNumber.gfx('PRF')).toMatch(/^PRF-[A-Z0-9]+-[A-Z0-9]{3}$/);
  });
  it('wq: WQ-MMDDYY + random suffix', () => {
    expect(legacyJobNumber.wq()).toMatch(/^WQ-\d{6}-[A-Z0-9]{3}$/);
  });
});
