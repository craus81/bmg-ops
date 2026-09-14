import { describe, it, expect, afterEach } from 'vitest';
import { ledgerPdfsEnabled, readLedgerSettings, LEDGER_SETTINGS_KEY } from './pdf-gate';

/**
 * A Supabase stand-in that really applies the key filter, so a test fails if
 * the query stops looking at the `ledger` row rather than merely asserting
 * the call was made (the fakeService pattern from quiet-leads.test.ts).
 */
function fakeService(rows: Array<{ key: string; value: unknown }>, opts: { fail?: boolean } = {}) {
  return {
    from: (table: string) => {
      let matched = table === 'app_settings' ? [...rows] : [];
      const q: any = {
        select: () => q,
        eq: (c: string, v: any) => { matched = matched.filter(r => (r as any)[c] === v); return q; },
        maybeSingle: () => Promise.resolve(
          opts.fail
            ? { data: null, error: { message: 'connection reset' } }
            : { data: matched[0] ?? null, error: null },
        ),
      };
      return q;
    },
  } as any;
}

const settingsRow = (value: unknown) => [{ key: LEDGER_SETTINGS_KEY, value }];

afterEach(() => { delete process.env.LEDGER_PDFS_ENABLED; });

describe('readLedgerSettings', () => {
  it('reads the ledger row only', async () => {
    const svc = fakeService([
      { key: 'booking_settings', value: { enabled: true } },
      { key: LEDGER_SETTINGS_KEY, value: { netsuite_since: '2015-01-01' } },
    ]);
    expect(await readLedgerSettings(svc)).toEqual({ netsuite_since: '2015-01-01' });
  });

  it('parses a row stored as a JSON string', async () => {
    const svc = fakeService(settingsRow(JSON.stringify({ pdfs_enabled_at: '2026-09-20T10:00:00Z' })));
    expect((await readLedgerSettings(svc)).pdfs_enabled_at).toBe('2026-09-20T10:00:00Z');
  });

  it('is {} for an absent row, an unparseable string, or a non-object', async () => {
    expect(await readLedgerSettings(fakeService([]))).toEqual({});
    expect(await readLedgerSettings(fakeService(settingsRow('not json')))).toEqual({});
    expect(await readLedgerSettings(fakeService(settingsRow([1, 2])))).toEqual({});
  });

  it('THROWS when the read fails — "nothing confirmed" and "could not ask" are different', async () => {
    // Swallowing the error here is how a Supabase outage turns into a
    // confirmed-looking "nothing is stamped" everywhere downstream (R7-1).
    await expect(readLedgerSettings(fakeService([], { fail: true })))
      .rejects.toThrow(/app_settings\.ledger could not be read: connection reset/);
  });
});

describe('ledgerPdfsEnabled', () => {
  it('opens on the literal string true — and only that', async () => {
    const svc = fakeService([]);
    process.env.LEDGER_PDFS_ENABLED = 'true';
    expect(await ledgerPdfsEnabled(svc)).toEqual({
      enabled: true, reason: 'Enabled via LEDGER_PDFS_ENABLED', via: 'env',
    });

    // '1' is the classic near-miss. It must NOT open a gate that decides
    // whether financial documents reach a bucket that is still public.
    for (const v of ['1', 'TRUE', 'yes', 'false', '']) {
      process.env.LEDGER_PDFS_ENABLED = v;
      expect((await ledgerPdfsEnabled(svc)).enabled, `LEDGER_PDFS_ENABLED=${JSON.stringify(v)}`).toBe(false);
    }
  });

  it('opens on the Settings → Company stamp, naming the date', async () => {
    const svc = fakeService(settingsRow({ pdfs_enabled_at: '2026-09-20T10:00:00Z', pdfs_enabled_by: 'u-1' }));
    const gate = await ledgerPdfsEnabled(svc);
    expect(gate.enabled).toBe(true);
    expect(gate.via).toBe('settings');
    expect(gate.reason).toBe('Enabled via Settings → Company (stamped 2026-09-20)');
  });

  it('is shut with a reason that names the runbook when nothing says otherwise', async () => {
    const gate = await ledgerPdfsEnabled(fakeService(settingsRow({ netsuite_since: '2015-01-01' })));
    expect(gate).toEqual({
      enabled: false,
      reason: 'Off — ledger PDFs are not written until the R2 privacy flip is verified (docs/r2-private-flip.md)',
      via: null,
    });
  });

  it('fails CLOSED when the settings row cannot be read — and SAYS it could not read it', async () => {
    // An unreadable settings row is not permission to write financial bytes
    // into a bucket whose privacy has not been proven — but the caller must
    // be able to tell "off" from "could not tell", or System Health prints
    // an outage as the flat fact "Off" (R7-1).
    const gate = await ledgerPdfsEnabled(fakeService([], { fail: true }));
    expect(gate.enabled).toBe(false);
    expect(gate.via).toBe(null);
    expect(gate.readError).toContain('connection reset');
    expect(gate.reason).toBe('Could not read the gate — app_settings.ledger could not be read: connection reset');
    expect(gate.reason).not.toContain('Off —');
  });

  it('reports no readError on the ordinary states', async () => {
    process.env.LEDGER_PDFS_ENABLED = 'true';
    expect((await ledgerPdfsEnabled(fakeService([]))).readError).toBeUndefined();
    delete process.env.LEDGER_PDFS_ENABLED;
    expect((await ledgerPdfsEnabled(fakeService([]))).readError).toBeUndefined();
    expect((await ledgerPdfsEnabled(fakeService(settingsRow({ pdfs_enabled_at: '2026-09-20T10:00:00Z' })))).readError)
      .toBeUndefined();
  });
});
