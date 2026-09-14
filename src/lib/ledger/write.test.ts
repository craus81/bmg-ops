import { describe, it, expect, vi } from 'vitest';
import {
  LEDGER_READ_ONLY,
  SLASH_KEYED_TABLES,
  appendEvents,
  replaceChildren,
  stampSynced,
  upsertRows,
  writeImportPointer,
  writeSyncStateCursor,
} from './write';
import { makeFakeService, resetFakeIds, writesTo } from '@/lib/quickbooks/test-fake-service';

const row = (externalId: string, over: Record<string, unknown> = {}) => ({
  source: 'quickbooks',
  external_id: externalId,
  external_ref: externalId.split('/')[1],
  doc_date: '2020-01-01',
  total: 10,
  ...over,
});

describe('upsertRows — provenance', () => {
  it('stamps last_synced_at on EVERY write and never sends first_seen_at', async () => {
    resetFakeIds();
    const svc = makeFakeService();
    const { ids, errors } = await upsertRows(svc as any, 'ledger_invoices', [row('Invoice/1')], { onConflict: 'source,external_id' });
    expect(errors).toEqual([]);
    expect(ids.get('Invoice/1')).toBeTruthy();
    const [write] = writesTo(svc, 'ledger_invoices');
    expect(write.rows[0].last_synced_at).toBeTruthy();
    expect(write.rows[0]).not.toHaveProperty('first_seen_at');
  });

  it('a SECOND upsert of the same key advances last_synced_at and leaves first_seen_at alone', async () => {
    // PostgREST's ON CONFLICT updates only the columns sent. Without the
    // stamp, last_synced_at would freeze at first import (its DEFAULT fires
    // on INSERT only) and every "when did we last see this" answer would be
    // false.
    const svc = makeFakeService({
      ledger_invoices: [{ id: 'x', source: 'quickbooks', external_id: 'Invoice/1', first_seen_at: '2019-01-01T00:00:00Z', last_synced_at: '2019-01-01T00:00:00Z' }],
    });
    await upsertRows(svc as any, 'ledger_invoices', [row('Invoice/1')], { onConflict: 'source,external_id' });
    const stored = svc.tables.ledger_invoices[0];
    expect(stored.first_seen_at).toBe('2019-01-01T00:00:00Z');
    expect(new Date(stored.last_synced_at).getTime()).toBeGreaterThan(Date.parse('2019-01-01T00:00:00Z'));
  });

  it('STRIPS a first_seen_at a caller sent rather than trusting it', async () => {
    const svc = makeFakeService();
    await upsertRows(svc as any, 'ledger_invoices', [row('Invoice/2', { first_seen_at: '1999-01-01T00:00:00Z' })], { onConflict: 'source,external_id' });
    expect(writesTo(svc, 'ledger_invoices')[0].rows[0]).not.toHaveProperty('first_seen_at');
  });
});

describe('upsertRows — guards', () => {
  it("refuses source 'fleetsuite' — those rows belong to the app, not an importer", async () => {
    const svc = makeFakeService();
    await expect(
      upsertRows(svc as any, 'ledger_invoices', [row('Invoice/3', { source: 'fleetsuite' })], { onConflict: 'source,external_id' }),
    ).rejects.toThrow(LEDGER_READ_ONLY);
    expect(writesTo(svc, 'ledger_invoices')).toEqual([]);
  });

  it("refuses an external_id with no '/' — including a report snapshot key", async () => {
    const svc = makeFakeService();
    await expect(
      upsertRows(svc as any, 'ledger_invoices', [row('Invoice/4', { external_id: 'ProfitAndLoss:accrual:2024-01-01:2024-01-31:Total' })], { onConflict: 'source,external_id' }),
    ).rejects.toThrow(/must be '<Type>\/<id>'/);
  });
});

describe('upsertRows — per-row fallback', () => {
  it('falls back to one row at a time when the bulk statement fails, and reports what still fails', async () => {
    let bulkCalls = 0;
    const svc = makeFakeService();
    const real = svc.from;
    (svc as any).from = (table: string) => {
      const q = real(table);
      const originalUpsert = q.upsert;
      q.upsert = (rows: any) => {
        const built = originalUpsert(rows);
        if (Array.isArray(rows) && rows.length > 1) {
          bulkCalls++;
          built.select = () => ({ then: (res: any) => Promise.resolve({ data: null, error: { message: 'bulk exploded' } }).then(res) });
        }
        return built;
      };
      return q;
    };

    const { ids, errors } = await upsertRows(
      svc as any,
      'ledger_invoices',
      [row('Invoice/10'), row('Invoice/11')],
      { onConflict: 'source,external_id' },
    );
    expect(bulkCalls).toBe(1);
    // Both rows still land, one statement at a time.
    expect(ids.size).toBe(2);
    expect(errors).toEqual([]);
  });
});

describe('replaceChildren / stampSynced', () => {
  it('deletes then inserts, and the stamp is a SEPARATE step', async () => {
    const svc = makeFakeService({
      ledger_invoice_lines: [{ id: 'old', document_id: 'p1', amount: 1 }],
      ledger_invoices: [{ id: 'p1', lines_synced_at: null }],
    });
    const byParent = new Map([['p1', [{ document_id: 'p1', line_external_id: '1', amount: 5 }]]]);
    const { inserted, errors } = await replaceChildren(svc as any, 'ledger_invoice_lines', 'document_id', byParent);
    expect(errors).toEqual([]);
    expect(inserted).toBe(1);
    expect(svc.tables.ledger_invoice_lines.map(r => r.amount)).toEqual([5]);
    // Not stamped yet: a chunk killed here leaves the parent pending and the
    // repair phase picks it up.
    expect(svc.tables.ledger_invoices[0].lines_synced_at).toBeNull();

    await stampSynced(svc as any, 'ledger_invoices', 'lines_synced_at', ['p1']);
    expect(svc.tables.ledger_invoices[0].lines_synced_at).toBeTruthy();
  });
});

describe('appendEvents', () => {
  it('RE-SANITIZES a raw it is handed — a card-bearing object stores no digits', async () => {
    // ledger_import_events is reader-visible; a caller that forgets to
    // sanitize still cannot leak an instrument through it.
    const svc = makeFakeService();
    await appendEvents(svc as any, 'run-1', [{
      phase: 'transactions',
      entityType: 'Payment',
      externalId: 'Payment/1',
      outcome: 'error',
      raw: { CreditCardPayment: { CreditChargeInfo: { Number: '4111111111111111' } }, Id: '1' },
    }], { seen: 0, max: 5000 });
    const [write] = writesTo(svc, 'ledger_import_events');
    expect(JSON.stringify(write.rows[0].raw)).not.toMatch(/\d{13,19}/);
    expect(write.rows[0].raw).toEqual({ Id: '1' });
  });

  it('honours the 5,000-row cap and reports how many it took', async () => {
    const svc = makeFakeService();
    const cap = { seen: 4_998, max: 5000 as const };
    const events = Array.from({ length: 10 }, (_, i) => ({
      phase: null, entityType: 'Invoice', externalId: `Invoice/${i}`, outcome: 'error' as const,
    }));
    expect(await appendEvents(svc as any, 'run-1', events, cap)).toBe(2);
    expect(cap.seen).toBe(5_000);
    expect(await appendEvents(svc as any, 'run-1', events, cap)).toBe(0);
  });

  it('writes nothing for an empty list', async () => {
    const svc = makeFakeService();
    expect(await appendEvents(svc as any, 'run-1', [], { seen: 0, max: 5000 })).toBe(0);
    expect(writesTo(svc, 'ledger_import_events')).toEqual([]);
  });
});

describe('writeSyncStateCursor', () => {
  it('NEVER touches last_synced_at and writes no cron_runs row', async () => {
    // A mid-run page cursor is not a data watermark, and recordHeartbeat
    // would append one cron_runs row per page.
    const svc = makeFakeService();
    await writeSyncStateCursor(svc as any, 'ledger_qbo_import', { phase: 'transactions' });
    const [write] = writesTo(svc, 'sync_state');
    expect(write.rows[0]).not.toHaveProperty('last_synced_at');
    expect(write.rows[0].updated_at).toBeTruthy();
    expect(write.rows[0].last_result.phase).toBe('transactions');
    expect(writesTo(svc, 'cron_runs')).toEqual([]);
  });
});

describe('writeImportPointer', () => {
  it('mirrors the cursor with a resume block', async () => {
    const svc = makeFakeService();
    await writeImportPointer(svc as any, {
      runId: 'run-1', mode: 'import', phase: 'transactions', entity: 'Invoice',
      status: 'running', partial: true, startPosition: 401,
    });
    const [write] = writesTo(svc, 'sync_state');
    expect(write.rows[0].sync_type).toBe('ledger_qbo_import');
    expect(write.rows[0].last_result.resume).toEqual({
      runId: 'run-1', phase: 'transactions', entity: 'Invoice', startPosition: 401,
    });
  });

  it("the type has no 'dry_run' mode — a dry run cannot write a pointer", () => {
    // A compile-time guarantee, asserted here so the intent is visible: the
    // line below does not typecheck, which is the whole enforcement.
    const src = require('fs').readFileSync(require('path').join(process.cwd(), 'src/lib/ledger/write.ts'), 'utf8');
    expect(src).toMatch(/mode: 'import' \| 'cdc'/);
    expect(src).not.toMatch(/mode: 'dry_run'/);
  });
});

describe('a failed write is reported, not swallowed', () => {
  it('logs a heartbeat cursor failure rather than throwing mid-chunk', async () => {
    const svc = makeFakeService();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    (svc as any).from = () => ({
      upsert: () => ({ then: (res: any) => Promise.resolve({ error: { message: 'nope' } }).then(res) }),
    });
    await writeSyncStateCursor(svc as any, 'ledger_qbo_import', {});
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('SLASH_KEYED_TABLES', () => {
  it('is every DATA table, and deliberately NOT ledger_report_snapshots', () => {
    // The snapshots table's key is ':'-joined, so it upserts directly and
    // never meets the slash guard (§2.7).
    expect([...SLASH_KEYED_TABLES]).toEqual([
      'ledger_accounts', 'ledger_entities', 'ledger_customers', 'ledger_documents',
      'ledger_invoices', 'ledger_bills', 'ledger_payments', 'ledger_journal_entries',
    ]);
    expect([...SLASH_KEYED_TABLES]).not.toContain('ledger_report_snapshots');
  });
});
