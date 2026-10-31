import { describe, it, expect } from 'vitest';
import { customerFacts, parseTermsCustomer, planCustomerTerms, type CustomerTermsEdit, type TermsCustomer, type TermsOption } from './customer-terms';

// A customer's terms and credit limit changed in FleetSuite and sent on to NetSuite (Books part 41): reading the
// customer as NetSuite's REST GET gives it, and what a change sends NetSuite and says. Made-up data.

/** Harbor Fleet Services as GET customer/4410 answers it: Due on receipt, no credit limit, $1,234.50 owed. */
const RECORD = {
  id: '4410', entityId: 'C-4410 Harbor Fleet', companyName: 'Harbor Fleet Services', isPerson: false, isInactive: false,
  terms: { id: '1', refName: 'Due on receipt' }, creditLimit: null, balance: 1234.5,
};
const TERMS: ReadonlyMap<string, TermsOption> = new Map([
  ['1', { id: '1', name: 'Due on receipt' }],
  ['2', { id: '2', name: 'Net 30' }],
  ['3', { id: '3', name: 'Net 45' }],
]);

const customer = parseTermsCustomer(RECORD);
const limited: TermsCustomer = { ...customer, creditLimitCents: 2_500_000 };
const plan = (edit: Partial<CustomerTermsEdit>, c: TermsCustomer = customer) =>
  planCustomerTerms(c, { reason: 'Credit application approved', ...edit }, { terms: TERMS });

describe('parseTermsCustomer', () => {
  it('reads its terms, credit limit and what it owes', () => {
    expect(customer).toEqual({
      id: '4410', name: 'Harbor Fleet Services', entityId: 'C-4410 Harbor Fleet', inactive: false,
      termsId: '1', termsName: 'Due on receipt', creditLimitCents: null, balanceCents: 123_450,
    });
    expect(parseTermsCustomer({ ...RECORD, creditLimit: 25000, balance: '0' })).toMatchObject({ creditLimitCents: 2_500_000, balanceCents: 0 });
    expect(parseTermsCustomer({ ...RECORD, creditLimit: '1000.005' }).creditLimitCents).toBe(100_000);
    for (const nothing of [undefined, null, '', 'lots']) {
      expect(parseTermsCustomer({ ...RECORD, creditLimit: nothing, balance: nothing })).toMatchObject({ creditLimitCents: null, balanceCents: null });
    }
  });

  it('names a person, or its id, and reads the flags NetSuite writes as T', () => {
    expect(parseTermsCustomer({ id: 4411, firstName: 'Pat', lastName: ' Example ', isInactive: 'T' })).toEqual({
      id: '4411', name: 'Pat Example', entityId: '', inactive: true, termsId: null, termsName: null, creditLimitCents: null, balanceCents: null,
    });
    expect(parseTermsCustomer({ id: '4412', entityId: 'C-4412', isInactive: true })).toMatchObject({ name: 'C-4412', inactive: true });
    expect(parseTermsCustomer({ id: '4412', isInactive: 'F' })).toMatchObject({ name: 'Customer 4412', inactive: false });
    expect(parseTermsCustomer(null)).toMatchObject({ id: '', name: 'Customer ', inactive: false });
  });

  it('reads its terms only from an id NetSuite gives as a number', () => {
    expect(parseTermsCustomer({ ...RECORD, terms: { id: 2 } })).toMatchObject({ termsId: '2', termsName: null });
    expect(parseTermsCustomer({ ...RECORD, terms: { id: 'x', refName: 'Net 30' } })).toMatchObject({ termsId: null, termsName: null });
    expect(parseTermsCustomer({ ...RECORD, terms: '2' })).toMatchObject({ termsId: null, termsName: null });
    expect(parseTermsCustomer({ ...RECORD, terms: null })).toMatchObject({ termsId: null, termsName: null });
  });
});

describe('customerFacts', () => {
  it('changes with anything a change is worked out from, and nothing else', () => {
    const facts = customerFacts(customer);
    expect(customerFacts(parseTermsCustomer(RECORD))).toBe(facts);
    for (const c of [{ id: '4411' }, { name: 'Harbor Fleet' }, { termsId: '2' }, { termsId: null }, { creditLimitCents: 0 }]) {
      expect(customerFacts({ ...customer, ...c })).not.toBe(facts);
    }
    // What it owes moves with every invoice and payment; a change doesn't hang on it.
    expect(customerFacts({ ...customer, balanceCents: 0, termsName: 'COD', inactive: true, entityId: 'C-1' })).toBe(facts);
  });
});

describe('planCustomerTerms', () => {
  it("changes its terms to one of NetSuite's, and won't take them off", () => {
    expect(plan({ termsId: '2' })).toEqual({ body: { terms: { id: '2' } }, changes: ['Terms Due on receipt → Net 30'], problems: [] });
    expect(plan({ termsId: '' }).problems).toEqual(["Terms can't be taken off here: pick the terms it should have."]);
    expect(plan({ termsId: '9' }).problems).toEqual(["Pick terms from NetSuite's list of them."]);
    expect(plan({ termsId: '9' }).body).toEqual({});
    expect(plan({ termsId: '1' }).problems).toEqual(['Nothing has changed yet.']);

    const none = { ...customer, termsId: null, termsName: null };
    expect(plan({ termsId: '' }, none).problems).toEqual(['Nothing has changed yet.']);
    expect(plan({ termsId: '3' }, none).changes).toEqual(['Terms (none) → Net 45']);
    expect(plan({ termsId: '3' }, { ...customer, termsName: null }).changes).toEqual(['Terms Due on receipt → Net 45']);
    // Its terms by the name NetSuite gave them on the customer, before the name in the copy of NetSuite's list.
    expect(plan({ termsId: '3' }, { ...customer, termsName: 'Due upon receipt' }).changes).toEqual(['Terms Due upon receipt → Net 45']);
    expect(plan({ termsId: '3' }, { ...customer, termsId: '8', termsName: null }).changes).toEqual(['Terms Terms 8 → Net 45']);
  });

  it('sets a credit limit to the cent, or takes it off', () => {
    expect(plan({ creditLimit: 25000 })).toEqual({ body: { creditLimit: 25000 }, changes: ['Credit limit no limit → $25,000.00'], problems: [] });
    expect(plan({ creditLimit: 0 }).changes).toEqual(['Credit limit no limit → $0.00']);
    expect(plan({ creditLimit: 0.1 + 0.2 }).problems).toEqual([]);
    expect(plan({ creditLimit: 0.1 + 0.2 }).body).toEqual({ creditLimit: 0.3 });
    expect(plan({ creditLimit: 30000.25 }, limited).changes).toEqual(['Credit limit $25,000.00 → $30,000.25']);
    expect(plan({ creditLimit: null }, limited)).toEqual({ body: { creditLimit: null }, changes: ['Credit limit $25,000.00 → no limit'], problems: [] });
    expect(plan({ creditLimit: null }).problems).toEqual(['Nothing has changed yet.']);
    expect(plan({ creditLimit: 25000 }, limited).problems).toEqual(['Nothing has changed yet.']);
  });

  it("won't send a credit limit that isn't one", () => {
    expect(plan({ creditLimit: Number.NaN }).problems).toEqual(['Enter the credit limit, or leave it blank for no limit.']);
    expect(plan({ creditLimit: Number.POSITIVE_INFINITY }).problems).toEqual(['Enter the credit limit, or leave it blank for no limit.']);
    expect(plan({ creditLimit: -0.01 }).problems).toEqual(["A credit limit can't be less than $0."]);
    expect(plan({ creditLimit: 100_000_000.01 }).problems).toEqual(['A credit limit can be $100,000,000.00 at most.']);
    expect(plan({ creditLimit: 100_000_000 }).problems).toEqual([]);
    expect(plan({ creditLimit: 25000.005 }).problems).toEqual(['The credit limit goes to the cent.']);
    expect(plan({ creditLimit: -1, termsId: '2' }).body).toEqual({ terms: { id: '2' } });
  });

  it('changes both at once', () => {
    expect(plan({ termsId: '2', creditLimit: 25000 })).toEqual({
      body: { terms: { id: '2' }, creditLimit: 25000 },
      changes: ['Terms Due on receipt → Net 30', 'Credit limit no limit → $25,000.00'],
      problems: [],
    });
  });

  it('needs why, and something changed', () => {
    expect(plan({ reason: ' ', termsId: '2' }).problems).toEqual(["Say why it's being changed."]);
    expect(plan({ reason: 'W'.repeat(301), termsId: '2' }).problems).toEqual(["Why it's being changed takes 300 characters at most."]);
    expect(plan({ reason: ` ${'W'.repeat(300)} `, termsId: '2' }).problems).toEqual([]);
    expect(plan({}).problems).toEqual(['Nothing has changed yet.']);
    expect(plan({ reason: '' }).problems).toEqual(["Say why it's being changed."]);
  });
});
