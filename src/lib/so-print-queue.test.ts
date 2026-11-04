import { describe, it, expect, vi, beforeEach } from 'vitest';

const notifyMany = vi.fn(async () => {});
vi.mock('@/lib/notify', () => ({ notifyMany }));

import {
  buildToPrintNotification, isoDay, syncedOrderQualifies,
  queueNewSalesOrder, requeuePrintedSalesOrder, requeueForNewPo, SO_TO_PRINT_URL,
} from './so-print-queue';
import { endUserBody, normalizeEndUser, END_USER_FIELD } from './end-user';
import { vendorPoText } from './job-order';
import { planSalesOrderEdit, parseSalesOrderRecord } from './sales-order-edit';

/** A tiny fake of the supabase calls this file makes. */
function fakeDb(opts: { queue?: any[]; prefs?: any[]; projects?: any[] } = {}) {
  const queue = [...(opts.queue || [])];
  const prefs = opts.prefs || [{ user_id: 'jessie', prints_sales_orders: true }, { user_id: 'craig', copy_new_alerts: true }];
  const projects = opts.projects || [];
  const from = (table: string) => {
    const filters: [string, any][] = [];
    let op: 'select' | 'update' | 'upsert' = 'select';
    let patch: any = null;
    let inFilter: [string, any[]] | null = null;
    const rowsFor = () => {
      const src = table === 'so_print_queue' ? queue : table === 'notification_preferences' ? prefs : projects;
      return src.filter(r => filters.every(([k, v]) => r[k] === v) && (!inFilter || inFilter[1].includes(r[inFilter[0]])));
    };
    const b: any = {
      select: () => b,
      eq: (k: string, v: any) => { filters.push([k, v]); return b; },
      in: (k: string, v: any[]) => { inFilter = [k, v]; return b; },
      update: (p: any) => { op = 'update'; patch = p; return b; },
      upsert: (row: any) => {
        op = 'upsert';
        const exists = queue.some(r => r.so_netsuite_id === row.so_netsuite_id);
        patch = exists ? null : row;
        if (!exists) queue.push({ ...row });
        return b;
      },
      then: (res: any) => {
        if (op === 'upsert') return Promise.resolve({ data: patch ? [{ id: 'new' }] : [], error: null }).then(res);
        const rows = rowsFor();
        if (op === 'update') rows.forEach(r => Object.assign(r, patch));
        return Promise.resolve({ data: rows, error: null }).then(res);
      },
    };
    return b;
  };
  return { db: { from }, queue };
}

beforeEach(() => notifyMany.mockClear());

describe('end user', () => {
  it('tidies the name and writes it to the spare NetSuite field', () => {
    expect(normalizeEndUser('  Jerry   Kelly  ')).toBe('Jerry Kelly');
    expect(endUserBody(' JW Mechanical ')).toEqual({ [END_USER_FIELD]: 'JW Mechanical' });
    expect(endUserBody('   ')).toEqual({});
    expect(END_USER_FIELD).toBe('custbody_vehicle_info_');
  });

  it('is read from and edited on the sales order', () => {
    const view = parseSalesOrderRecord({ id: '9', tranId: 'SO1204', custbody_vehicle_info_: 'Jerry Kelly', item: { items: [] } });
    expect(view.header.endUser).toBe('Jerry Kelly');
    const plan = planSalesOrderEdit(view, { header: { endUser: 'Bommarito' } });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.body).toEqual({ custbody_vehicle_info_: 'Bommarito' });
      expect(plan.changes).toEqual(['End user Jerry Kelly → Bommarito']);
    }
    const same = planSalesOrderEdit(view, { header: { endUser: ' Jerry  Kelly ' } });
    expect(same).toEqual({ ok: false, errors: ['Nothing changed.'] });
  });
});

describe('board copy', () => {
  it('lists vendor POs with their vendor', () => {
    expect(vendorPoText([{ number: '35052221', vendor: 'Masterack' }, { number: '35052240', vendor: null }])).toBe('35052221 (Masterack), 35052240');
    expect(vendorPoText([])).toBe('');
  });
});

describe('alert wording', () => {
  const so = { soNetsuiteId: '9', soNumber: 'SO1204', customerName: 'Clement Ford', endUser: 'Jerry Kelly' };
  it('names the order, customer and end user', () => {
    expect(buildToPrintNotification(so, 'new')).toEqual({ title: 'SO1204 to print', body: 'Clement Ford, end user Jerry Kelly · New sales order for the board.' });
    expect(buildToPrintNotification(so, 'changed').title).toBe('SO1204 changed: print it again');
    expect(buildToPrintNotification(so, 'new_po', '35052221').body).toContain('(PO 35052221)');
  });
});

describe('which synced orders join the list', () => {
  it('only orders dated from the start day on', () => {
    expect(isoDay('11/4/2026')).toBe('2026-11-04');
    expect(isoDay('2026-11-05T00:00:00Z')).toBe('2026-11-05');
    expect(syncedOrderQualifies('11/4/2026')).toBe(true);
    expect(syncedOrderQualifies('11/3/2026')).toBe(false);
    expect(syncedOrderQualifies(null)).toBe(false);
  });
});

describe('the list', () => {
  it('adds a new order once and alerts Jessie and Craig', async () => {
    const { db, queue } = fakeDb();
    expect(await queueNewSalesOrder(db, { soNetsuiteId: '9', soNumber: 'SO1204', customerName: 'Clement Ford' })).toBe(true);
    expect(await queueNewSalesOrder(db, { soNetsuiteId: '9', soNumber: 'SO1204' })).toBe(false);
    expect(queue).toHaveLength(1);
    expect(notifyMany).toHaveBeenCalledTimes(1);
    const [ids, payload] = notifyMany.mock.calls[0] as any;
    expect(new Set(ids)).toEqual(new Set(['jessie', 'craig']));
    expect(payload).toMatchObject({ type: 'so_to_print', url: SO_TO_PRINT_URL });
  });

  it('puts a printed order back when it changes, but leaves a waiting one alone', async () => {
    const { db, queue } = fakeDb({ queue: [
      { so_netsuite_id: '9', so_number: 'SO1204', status: 'printed', reason: 'new' },
      { so_netsuite_id: '10', so_number: 'SO1205', status: 'to_print', reason: 'new' },
    ] });
    expect(await requeuePrintedSalesOrder(db, '9', 'changed')).toBe(true);
    expect(queue[0]).toMatchObject({ status: 'to_print', reason: 'changed' });
    expect(await requeuePrintedSalesOrder(db, '10', 'changed')).toBe(false);
    expect(queue[1].reason).toBe('new');
    expect(await requeuePrintedSalesOrder(db, '11', 'changed')).toBe(false);
    expect(notifyMany).toHaveBeenCalledTimes(1);
  });

  it('a new vendor PO on the job puts its printed order back', async () => {
    const { db, queue } = fakeDb({
      queue: [{ so_netsuite_id: '9', so_number: 'SO1204', status: 'printed', reason: 'new' }],
      projects: [{ id: 'p1', netsuite_so_id: '9' }],
    });
    expect(await requeueForNewPo(db, ['p1'], '35052221')).toBe(1);
    expect(queue[0]).toMatchObject({ status: 'to_print', reason: 'new_po' });
    expect((notifyMany.mock.calls[0] as any)[1].title).toBe('SO1204 has a new vendor PO: print it again');
  });
});
