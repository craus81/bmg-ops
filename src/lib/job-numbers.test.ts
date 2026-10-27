import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { join } from 'path';
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

/**
 * Migration 446 on a real Postgres: a counter that fell behind the numbers
 * already in the table skips past them instead of handing out a taken one.
 */
it('migration 446 next_job_number skips numbers already in use', async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE job_number_sequences (prefix text not null, period text not null, last_seq int not null default 0, primary key (prefix, period));
    CREATE TABLE wrap_quotes (id serial primary key, quote_number text not null unique);
    CREATE TABLE estimates (id serial primary key, estimate_number text not null unique);
    CREATE TABLE graphics_jobs (id serial primary key, job_number text);
    CREATE TABLE pricing_requests (id serial primary key, request_number text not null unique);
    DO $$ BEGIN CREATE ROLE authenticated; CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await db.exec(readFileSync(join(__dirname, '../../migrations/446-job-number-skip-taken.sql'), 'utf8'));
  const period = (await db.query<{ p: string }>(`SELECT to_char(now(), 'YYMM') AS p`)).rows[0].p;
  // The counter says 1 was the last WQ handed out, but 2 and 3 are taken.
  await db.exec(`
    INSERT INTO job_number_sequences VALUES ('WQ', '${period}', 1);
    INSERT INTO wrap_quotes (quote_number) VALUES ('WQ-${period}-002'), ('WQ-${period}-003'), ('WQ-${period}-005');
    INSERT INTO estimates (estimate_number) VALUES ('EST-${period}-001');
  `);
  const next = async (p: string) => (await db.query<{ n: string }>(`SELECT public.next_job_number($1) AS n`, [p])).rows[0].n;
  expect(await next('WQ')).toBe(`WQ-${period}-004`);
  expect(await next('WQ')).toBe(`WQ-${period}-006`);
  expect(await next('EST')).toBe(`EST-${period}-002`);
  expect(await next('GFX')).toBe(`GFX-${period}-001`);
  await expect(next('bad1')).rejects.toThrow(/invalid job number prefix/);
});
