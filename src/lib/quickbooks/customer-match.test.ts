import { describe, it, expect } from 'vitest';
import { candidatesFor, cleanQboName, gradeInMemory, loadCustomerIndex, type CustomerIndexRow } from './customer-match';
import { makeFakeService } from './test-fake-service';

/**
 * This is the NEW `src/lib/quickbooks/customer-match.ts`. The shared
 * `src/lib/customer-match.ts` is untouched by this work — its rules are
 * re-expressed here in memory so the importer does not run one query per
 * QuickBooks customer.
 */

const c = (over: Partial<CustomerIndexRow>): CustomerIndexRow => ({
  id: 'cust-1', netsuite_id: '4821', company_name: 'Broadway Ford', entity_id: 'BROADWAY', email: null, phone_digits: null,
  ...over,
});

describe('cleanQboName — the "double names" problem (owner item 6)', () => {
  it('prefers CompanyName, which is the field that was not doubled', () => {
    expect(cleanQboName('Broadway Ford Broadway Ford', 'Broadway Ford')).toBe('Broadway Ford');
  });

  it('collapses an exactly doubled display name', () => {
    expect(cleanQboName('Broadway Ford Broadway Ford')).toBe('Broadway Ford');
    expect(cleanQboName('Acme, Acme')).toBe('Acme');
  });

  it('leaves a real repeated word alone', () => {
    // An odd token count, so the halves cannot match — collapsing on any
    // repeat would rename real companies.
    expect(cleanQboName('Ford Ford Dealership')).toBe('Ford Ford Dealership');
  });

  it('drops the " (deleted)" suffix QuickBooks appends to inactive records', () => {
    expect(cleanQboName('Broadway Ford (deleted)')).toBe('Broadway Ford');
  });

  it('cuts a Customer:Job name at the colon — the parent is the customer', () => {
    expect(cleanQboName('Broadway Ford:Van #12')).toBe('Broadway Ford');
  });

  it('normalizes whitespace and returns empty for nothing', () => {
    expect(cleanQboName('  Broadway   Ford  ')).toBe('Broadway Ford');
    expect(cleanQboName('')).toBe('');
  });

  it('an empty CompanyName does not win over a usable DisplayName', () => {
    expect(cleanQboName('Broadway Ford Broadway Ford', '   ')).toBe('Broadway Ford');
  });
});

describe('gradeInMemory — the graded ladder', () => {
  const index = [
    c({ id: 'a', netsuite_id: '1', company_name: 'Broadway Ford', entity_id: 'BWFORD' }),
    c({ id: 'b', netsuite_id: '2', company_name: 'Masterack LLC', entity_id: 'MSTRK' }),
    c({ id: 'c', netsuite_id: '3', company_name: 'Masterack Industries', entity_id: 'MSTRKIND' }),
  ];

  it('exact company name on the RAW name grades exact', () => {
    const g = gradeInMemory(index, { displayName: 'Broadway Ford', cleanedName: 'Broadway Ford' });
    expect(g).toMatchObject({ status: 'exact' });
    expect((g as any).customer.id).toBe('a');
  });

  it('a name that only matches AFTER cleanup grades cleaned', () => {
    // The distinction the owner's report is built around.
    const g = gradeInMemory(index, { displayName: 'Broadway Ford Broadway Ford', cleanedName: 'Broadway Ford' });
    expect(g).toMatchObject({ status: 'cleaned' });
    expect((g as any).customer.id).toBe('a');
  });

  it('matches an exact entity id when the company name does not', () => {
    const g = gradeInMemory(index, { displayName: 'MSTRK', cleanedName: 'MSTRK' });
    expect(g).toMatchObject({ status: 'exact' });
    expect((g as any).customer.id).toBe('b');
  });

  it('an unambiguous prefix is accepted', () => {
    const g = gradeInMemory(index, { displayName: 'Broadway', cleanedName: 'Broadway' });
    expect(g).toMatchObject({ status: 'exact' });
    expect((g as any).customer.id).toBe('a');
  });

  it('TWO prefix hits is ambiguous, never a guess', () => {
    // This feeds financial history — attaching a decade of invoices to the
    // wrong customer is worse than leaving them in a queue.
    const g = gradeInMemory(index, { displayName: 'Masterack', cleanedName: 'Masterack' });
    expect(g.status).toBe('ambiguous');
    expect((g as any).candidates.map((x: CustomerIndexRow) => x.id).sort()).toEqual(['b', 'c']);
  });

  it('nothing at all grades unmatched', () => {
    expect(gradeInMemory(index, { displayName: 'Nobody Ltd', cleanedName: 'Nobody Ltd' })).toEqual({ status: 'unmatched' });
  });

  it('an empty name grades unmatched rather than matching everything', () => {
    expect(gradeInMemory(index, { displayName: '', cleanedName: '' })).toEqual({ status: 'unmatched' });
  });

  it('duplicate netsuite_id rows grade ambiguous — that is a data problem for a human', () => {
    const dupes = [
      c({ id: 'x', netsuite_id: '9', company_name: 'Acme' }),
      c({ id: 'y', netsuite_id: '9', company_name: 'Acme' }),
    ];
    const g = gradeInMemory(dupes, { displayName: 'Acme', cleanedName: 'Acme' });
    expect(g.status).toBe('ambiguous');
    expect((g as any).reason).toMatch(/share NetSuite id 9/);
  });

  it('grading is case-insensitive', () => {
    expect(gradeInMemory(index, { displayName: 'BROADWAY FORD', cleanedName: 'BROADWAY FORD' }).status).toBe('exact');
  });
});

describe('loadCustomerIndex', () => {
  it('reads only active NetSuite-linked customers', async () => {
    const svc = makeFakeService({
      customers: [
        { id: 'a', netsuite_id: '1', company_name: 'Live', entity_id: null, email: null, phone_digits: null, active: true },
        { id: 'b', netsuite_id: '2', company_name: 'Dead', entity_id: null, email: null, phone_digits: null, active: false },
        { id: 'c', netsuite_id: null, company_name: 'Local only', entity_id: null, email: null, phone_digits: null, active: true },
      ],
    });
    const index = await loadCustomerIndex(svc as any);
    expect(index.map(r => r.id)).toEqual(['a']);
  });

  it('a failed read THROWS rather than grading everything unmatched', async () => {
    const svc = makeFakeService({ customers: [] });
    svc.failReadsOn.add('customers');
    await expect(loadCustomerIndex(svc as any)).rejects.toThrow(/Could not load the customer index/);
  });
});

describe('candidatesFor — customers rows ONLY', () => {
  it('returns a direct customers hit with its describeMatch text', async () => {
    const svc = makeFakeService({
      customers: [{ id: 'cust-1', company_name: 'Broadway Ford', email: null, phone: null, phone_digits: null, netsuite_id: '4821' }],
      prospects: [],
    });
    const { candidates, described } = await candidatesFor(svc as any, { cleanedName: 'Broadway Ford' });
    expect(candidates.map(c2 => c2.id)).toEqual(['cust-1']);
    expect(candidates[0].source).toBe('customers');
    expect(described[0]).toMatch(/Broadway Ford/);
  });

  it('resolves a PROSPECTS hit to its customers row by netsuite_id', async () => {
    const svc = makeFakeService({
      customers: [{ id: 'cust-9', company_name: 'Broadway Ford', email: null, phone: null, phone_digits: null, netsuite_id: '4821' }],
      prospects: [{ id: 'prospect-1', company_name: 'Broadway Ford', email: null, phone: null, phone_digits: null, netsuite_id: '4821', record_type: 'prospect' }],
    });
    const { candidates } = await candidatesFor(svc as any, { cleanedName: 'Broadway Ford' });
    expect(candidates.map(c2 => c2.id)).toEqual(['cust-9']);
  });

  it('a prospects-only hit with NO matching netsuite_id yields ZERO candidates', async () => {
    // ledger_customers.customer_id REFERENCES customers(id): offering a
    // prospects id would 23503 the moment the reviewer clicked the answer
    // the queue proposed.
    const svc = makeFakeService({
      customers: [],
      prospects: [{ id: 'prospect-1', company_name: 'Broadway Ford', email: null, phone: null, phone_digits: null, netsuite_id: null, record_type: 'prospect' }],
    });
    const { candidates } = await candidatesFor(svc as any, { cleanedName: 'Broadway Ford' });
    expect(candidates).toEqual([]);
  });

  it('a prospects hit whose netsuite_id names no customers row is dropped too', async () => {
    const svc = makeFakeService({
      customers: [{ id: 'cust-other', company_name: 'Someone Else', email: null, phone: null, phone_digits: null, netsuite_id: '999' }],
      prospects: [{ id: 'prospect-1', company_name: 'Broadway Ford', email: null, phone: null, phone_digits: null, netsuite_id: '4821', record_type: 'prospect' }],
    });
    const { candidates } = await candidatesFor(svc as any, { cleanedName: 'Broadway Ford' });
    expect(candidates).toEqual([]);
  });
});
