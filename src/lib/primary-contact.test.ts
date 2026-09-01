import { describe, expect, it } from 'vitest';
import { samePerson, setPrimaryContact } from './primary-contact';

describe('samePerson', () => {
  it('matches on email regardless of case and padding', () => {
    expect(samePerson({ email: 'Dana@acme.com' }, { email: ' dana@acme.com ' })).toBe(true);
  });

  it('lets email decide alone when both sides have one', () => {
    // A shared front-desk phone must not fuse two people.
    expect(samePerson(
      { name: 'Dana', email: 'dana@acme.com', phone: '574-555-0100' },
      { name: 'Dana', email: 'chris@acme.com', phone: '574-555-0100' },
    )).toBe(false);
  });

  it('falls back to the last 10 phone digits across formats', () => {
    expect(samePerson({ phone: '(574) 555-0100' }, { phone: '+15745550100' })).toBe(true);
    expect(samePerson({ email: 'dana@acme.com', phone: '5745550100' }, { phone: '574.555.0100' })).toBe(true);
  });

  it('falls back to the name when nothing else is shared', () => {
    expect(samePerson({ name: 'Dana  Reyes' }, { name: 'dana reyes' })).toBe(true);
    expect(samePerson({ name: 'Dana Reyes' }, { name: 'Chris Reyes' })).toBe(false);
  });

  it('does not match two records with no identifiers at all', () => {
    expect(samePerson({}, {})).toBe(false);
    expect(samePerson({ name: '' }, { name: '  ' })).toBe(false);
  });
});

/** Minimal stand-in for the external_contacts table. */
function fakeService(rows: any[]) {
  const calls: { demoted: any[]; updated: any[]; inserted: any[] } = { demoted: [], updated: [], inserted: [] };
  const api = {
    from() { return builder(); },
  };
  function builder() {
    const state: any = { op: null, values: null, eq: {}, neq: null };
    const b: any = {
      select() { return b; },
      update(values: any) { state.op = 'update'; state.values = values; return b; },
      insert(values: any) { state.op = 'insert'; state.values = values; return b; },
      eq(col: string, val: any) {
        state.eq[col] = val;
        // .eq('id', …) on an update targets one row; resolve on await.
        return b;
      },
      neq(_col: string, val: any) { state.neq = val; return b; },
      single() { return b; },
      then(resolve: any) {
        if (state.op === 'update' && state.eq.id) {
          calls.updated.push({ id: state.eq.id, values: state.values });
          const row = rows.find(r => r.id === state.eq.id);
          if (row) Object.assign(row, state.values);
          return resolve({ data: row, error: null });
        }
        if (state.op === 'update' && state.eq.customer_id) {
          const targets = rows.filter(r => r.customer_id === state.eq.customer_id && r.id !== state.neq);
          calls.demoted.push(targets.map(r => r.id));
          for (const r of targets) Object.assign(r, state.values);
          return resolve({ data: null, error: null });
        }
        if (state.op === 'insert') {
          const row = { id: `new-${rows.length + 1}`, ...state.values };
          rows.push(row);
          calls.inserted.push(row);
          return resolve({ data: row, error: null });
        }
        return resolve({ data: rows.filter(r => r.customer_id === state.eq.customer_id), error: null });
      },
    };
    return b;
  }
  return { service: api as any, rows, calls };
}

describe('setPrimaryContact', () => {
  it('reuses the SMS-created contact instead of forking a second one', async () => {
    const { service, rows } = fakeService([
      { id: 'x1', customer_id: 'c1', name: 'Unknown', phone: '+15745550100', email: null, title: null, is_primary: false },
    ]);
    const res = await setPrimaryContact(service, 'c1', {
      name: 'Dana Reyes', title: 'Fleet Manager', email: 'dana@acme.com', phone: '(574) 555-0100',
    });
    expect(res).toMatchObject({ ok: true, externalContactId: 'x1', created: false });
    expect(rows).toHaveLength(1);
    // The CRM row wins where it says something; the texted phone survives.
    expect(rows[0]).toMatchObject({ name: 'Dana Reyes', email: 'dana@acme.com', phone: '(574) 555-0100', is_primary: true });
  });

  it('creates an external contact when nobody matches', async () => {
    const { service, rows, calls } = fakeService([
      { id: 'x1', customer_id: 'c1', name: 'Chris', email: 'chris@acme.com', phone: null, is_primary: true },
    ]);
    const res = await setPrimaryContact(service, 'c1', { name: 'Dana Reyes', email: 'dana@acme.com' });
    expect(res).toMatchObject({ ok: true, created: true });
    expect(calls.inserted[0]).toMatchObject({ name: 'Dana Reyes', is_primary: true });
    // The old primary is demoted BEFORE the new one lands (single-primary index).
    expect(rows.find(r => r.id === 'x1')!.is_primary).toBe(false);
    expect(rows.filter(r => r.is_primary)).toHaveLength(1);
  });

  it('demotes the previous primary when promoting a sibling', async () => {
    const { service, rows } = fakeService([
      { id: 'x1', customer_id: 'c1', name: 'Chris', email: 'chris@acme.com', is_primary: true },
      { id: 'x2', customer_id: 'c1', name: 'Dana', email: 'dana@acme.com', is_primary: false },
    ]);
    await setPrimaryContact(service, 'c1', { name: 'Dana', email: 'dana@acme.com' });
    expect(rows.find(r => r.id === 'x1')!.is_primary).toBe(false);
    expect(rows.find(r => r.id === 'x2')!.is_primary).toBe(true);
  });

  it('syncs onto targetId even when the identifiers no longer match', async () => {
    // The primary's email was just edited in the CRM — samePerson would miss.
    const { service, rows } = fakeService([
      { id: 'x1', customer_id: 'c1', name: 'Dana', email: 'old@acme.com', phone: null, title: null, is_primary: true },
    ]);
    const res = await setPrimaryContact(
      service, 'c1',
      { name: 'Dana', email: 'new@acme.com' },
      { targetId: 'x1' },
    );
    expect(res).toMatchObject({ ok: true, externalContactId: 'x1', created: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'new@acme.com', is_primary: true });
  });
});
