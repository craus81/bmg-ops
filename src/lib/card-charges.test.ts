import { describe, it, expect } from 'vitest';
import {
  CARD_CHARGE_RULE, FIRST_SEND_MONTH, MAX_CHARGES_PER_ENTRY, MAX_FILE_ROWS, accountName, byDateThenId, chargeMemo,
  keptCharge, merchantKey, monthName, netsuiteJournalEntry, readChaseDownload, sendExternalId, workOutCardEntry,
  type CardAccount, type CardCharge, type CardCompany, type CardEntryFacts,
} from './card-charges';

// Made-up companies, accounts, merchants and charges.
const HEAD = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo';
const csv = (...lines: string[]) => lines.join('\n');

describe('merchantKey', () => {
  it('keeps the words before a store number or a reference', () => {
    expect(merchantKey('ACME HARDWARE #1234')).toBe('ACME HARDWARE');
    expect(merchantKey('ACME HARDWARE #5678')).toBe('ACME HARDWARE');
    expect(merchantKey('WIDGETS MKTPL*AB1CD2')).toBe('WIDGETS MKTPL');
    expect(merchantKey('WIDGETS MKTPL*ZZ9')).toBe('WIDGETS MKTPL');
    expect(merchantKey('acme hardware #1234 st louis')).toBe('ACME HARDWARE');
    expect(merchantKey('GAS 66 STATION')).toBe('GAS');
    expect(merchantKey('PAYPAL *ACMESUPPLY 4029357733')).toBe('PAYPAL ACMESUPPLY');
  });

  it("keeps a short word with digits in, and a number that's the first word", () => {
    expect(merchantKey('7-ELEVEN 12345')).toBe('7 ELEVEN');
    expect(merchantKey('3M COMPANY')).toBe('3M COMPANY');
    expect(merchantKey('B&B SUPPLY')).toBe('B&B SUPPLY');
    expect(merchantKey('SQ *JOES CAFE')).toBe('SQ JOES CAFE');
  });

  it('takes four words at most, the first word when nothing comes before a reference, and 60 characters', () => {
    expect(merchantKey('ONE TWO THREE FOUR FIVE')).toBe('ONE TWO THREE FOUR');
    expect(merchantKey('12345 MAIN ST PARKING')).toBe('12345');
    expect(merchantKey(' *** ')).toBe('');
    expect(merchantKey('X'.repeat(80))).toBe('X'.repeat(60));
  });
});

describe('readChaseDownload', () => {
  it('reads each charge: a purchase onto the card, money back off it, payments and $0 lines left out', () => {
    const file = csv(
      HEAD,
      '01/03/2027,01/04/2027,ACME HARDWARE #1234,Home,Sale,-125.50,',
      '01/05/2027,01/06/2027,"WIDGETS MKTPL*AB1CD2",Shopping,Sale,-42.10,Shelf bins',
      '01/07/2027,01/07/2027,ACME HARDWARE #5678,Home,Return,20.00,',
      '01/08/2027,01/08/2027,AUTOMATIC PAYMENT - THANK,,Payment,500.00,',
      '01/09/2027,01/10/2027,ANNUAL MEMBERSHIP FEE,Fees & Adjustments,Fee,-95.00,',
      '01/11/2027,01/11/2027,ZERO DOLLAR AUTH,Shopping,Sale,0.00,',
    );
    const d = readChaseDownload(file);
    expect(d.problems).toEqual([]);
    expect(d.payments).toBe(1);
    expect(d.zero).toBe(1);
    expect(d.rows).toEqual([
      {
        row: 1, date: '2027-01-03', postDate: '2027-01-04', description: 'ACME HARDWARE #1234', merchantKey: 'ACME HARDWARE',
        category: 'Home', type: 'Sale', cents: 12550, card: null, chaseMemo: null, fingerprint: '2027-01-03|2027-01-04|ACME HARDWARE #1234|12550|#1',
      },
      {
        row: 2, date: '2027-01-05', postDate: '2027-01-06', description: 'WIDGETS MKTPL*AB1CD2', merchantKey: 'WIDGETS MKTPL',
        category: 'Shopping', type: 'Sale', cents: 4210, card: null, chaseMemo: 'Shelf bins', fingerprint: '2027-01-05|2027-01-06|WIDGETS MKTPL*AB1CD2|4210|#1',
      },
      {
        row: 3, date: '2027-01-07', postDate: '2027-01-07', description: 'ACME HARDWARE #5678', merchantKey: 'ACME HARDWARE',
        category: 'Home', type: 'Return', cents: -2000, card: null, chaseMemo: null, fingerprint: '2027-01-07|2027-01-07|ACME HARDWARE #5678|-2000|#1',
      },
      {
        row: 5, date: '2027-01-09', postDate: '2027-01-10', description: 'ANNUAL MEMBERSHIP FEE', merchantKey: 'ANNUAL MEMBERSHIP FEE',
        category: 'Fees & Adjustments', type: 'Fee', cents: 9500, card: null, chaseMemo: null, fingerprint: '2027-01-09|2027-01-10|ANNUAL MEMBERSHIP FEE|9500|#1',
      },
    ]);
  });

  it('reads the Card column when the account has more than one card, so the same charge on two cards is two charges', () => {
    const d = readChaseDownload(csv(
      `Card,${HEAD}`,
      '1234,01/03/2027,01/04/2027,ACME HARDWARE #1234,Home,Sale,-125.50,',
      '5678,01/03/2027,01/04/2027,ACME HARDWARE #1234,Home,Sale,-125.50,',
    ));
    expect(d.rows.map((r) => [r.card, r.fingerprint])).toEqual([
      ['1234', '2027-01-03|2027-01-04|ACME HARDWARE #1234|12550|1234#1'],
      ['5678', '2027-01-03|2027-01-04|ACME HARDWARE #1234|12550|5678#1'],
    ]);
  });

  it('tells two identical charges in one file apart by their place, so a later download of the same days adds neither again', () => {
    const line = '01/03/2027,01/04/2027,ACME HARDWARE #1234,Home,Sale,-9.99,';
    const first = readChaseDownload(csv(HEAD, line, line)).rows.map((r) => r.fingerprint);
    expect(first).toEqual(['2027-01-03|2027-01-04|ACME HARDWARE #1234|999|#1', '2027-01-03|2027-01-04|ACME HARDWARE #1234|999|#2']);
    const later = readChaseDownload(csv(HEAD, '01/02/2027,01/02/2027,OTHER,Home,Sale,-1.00,', line, line)).rows.map((r) => r.fingerprint);
    expect(later.slice(1)).toEqual(first);
    // The description's case doesn't make it another charge.
    expect(readChaseDownload(csv(HEAD, line.replace('ACME HARDWARE', 'Acme Hardware'))).rows[0].fingerprint).toBe(first[0]);
  });

  it('reads a file whose sales are all above 0 the other way round', () => {
    const d = readChaseDownload(csv(
      HEAD,
      '01/03/2027,01/04/2027,ACME HARDWARE #1234,Home,Sale,125.50,',
      '01/07/2027,01/07/2027,ACME HARDWARE #5678,Home,Return,-20.00,',
      '01/08/2027,01/08/2027,AUTOMATIC PAYMENT - THANK,,Payment,-500.00,',
      '01/09/2027,01/09/2027,ZERO DOLLAR AUTH,Shopping,Sale,0.00,',
    ));
    expect(d.problems).toEqual([]);
    expect(d.rows.map((r) => r.cents)).toEqual([12550, -2000]);
    expect([d.payments, d.zero]).toEqual([1, 1]);
  });

  it("refuses a file whose sales go both ways, since it can't tell which way its amounts go", () => {
    const d = readChaseDownload(csv(
      HEAD,
      '01/03/2027,01/04/2027,ACME HARDWARE #1234,Home,Sale,-125.50,',
      '01/04/2027,01/05/2027,ACME HARDWARE #1234,Home,Sale,30.00,',
      '01/05/2027,01/06/2027,ACME HARDWARE #1234,Home,Sale,0,',
    ));
    expect(d.problems).toEqual(["Some sales in the file are money out and some money back (charge 2), so FleetSuite can't tell which way its amounts go."]);
    expect(d.rows).toEqual([]);
  });

  it('reads a download with only the three columns it needs, a payment by its description', () => {
    const d = readChaseDownload(csv(
      'Transaction Date,Description,Amount',
      '01/03/2027,ACME HARDWARE #1234,-125.50',
      '01/08/2027,PAYMENT THANK YOU,500.00',
      '01/09/2027,ACME PAYMENT SERVICES,-9.99',
      '01/10/2027,REFUND ACME,15.00',
    ));
    expect(d.problems).toEqual([]);
    expect(d.payments).toBe(1);
    expect(d.rows.map((r) => [r.row, r.cents, r.postDate, r.type, r.category, r.chaseMemo])).toEqual([
      [1, 12550, null, null, null, null],
      [3, 999, null, null, null, null],
      [4, -1500, null, null, null, null],
    ]);
  });

  it('finds the headings by name, whatever their case, spacing and order, after any lines above them', () => {
    const d = readChaseDownload([
      '﻿Activity for the card,,',
      ' amount ,DESCRIPTION, transaction  DATE ',
      '"$-1,234.56","ACME, ""THE"" STORE   #1234",1/3/2027',
      '(42.10),WIDGETS,01/04/2027',
    ].join('\r\n'));
    expect(d.problems).toEqual([]);
    expect(d.rows.map((r) => [r.date, r.description, r.merchantKey, r.cents])).toEqual([
      ['2027-01-03', 'ACME, "THE" STORE #1234', 'ACME THE STORE', 123456],
      ['2027-01-04', 'WIDGETS', 'WIDGETS', 4210],
    ]);
  });

  it('cuts a long description, memo and card to what FleetSuite keeps', () => {
    const d = readChaseDownload(csv(`Card,${HEAD}`, `${'9'.repeat(25)},01/03/2027,,${'A'.repeat(250)},,Sale,-1.00,${'m'.repeat(350)}`));
    expect(d.rows[0].description).toHaveLength(200);
    expect(d.rows[0].chaseMemo).toHaveLength(300);
    expect(d.rows[0].card).toHaveLength(20);
  });

  it('refuses the whole file when any line can\'t be read, and says which', () => {
    const d = readChaseDownload(csv(
      HEAD,
      '13/45/2027,01/04/2027,ACME,Home,Sale,-1.00,',
      '01/03/2027,soon,ACME,Home,Sale,-1.00,',
      '01/03/2027,01/04/2027,,Home,Sale,-1.00,',
      '01/03/2027,01/04/2027,ACME,Home,Sale,ten,',
      '01/03/2027,01/04/2027,ACME,Home,Sale,,',
      '01/03/2027,01/04/2027,ACME,Home,Sale,-1.00,',
    ));
    expect(d.problems).toEqual([
      'Charge 1: "13/45/2027" isn\'t a date.',
      'Charge 2: "soon" isn\'t a date.',
      'Charge 3 has no description.',
      'Charge 4: "ten" isn\'t an amount.',
      'Charge 5: "" isn\'t an amount.',
    ]);
    expect(d.rows).toEqual([]);
  });

  it("says when the file isn't a Chase card download", () => {
    const notChase = "This isn't a Chase card download: its first line should name Transaction Date, Description and Amount. "
      + 'In Chase, open the card, choose Download account activity, and pick CSV.';
    expect(readChaseDownload('').problems).toEqual([notChase]);
    expect(readChaseDownload(csv('Date,Name,Value', '01/03/2027,ACME,-1.00')).problems).toEqual([notChase]);
    expect(readChaseDownload(csv('Transaction Date,Description', '01/03/2027,ACME')).problems).toEqual([notChase]);
  });

  it(`takes ${MAX_FILE_ROWS} charges a file at most`, () => {
    const line = '01/03/2027,01/04/2027,ACME,Home,Sale,-1.00,';
    expect(readChaseDownload(csv(HEAD, ...Array.from({ length: MAX_FILE_ROWS }, () => line))).rows).toHaveLength(MAX_FILE_ROWS);
    expect(readChaseDownload(csv(HEAD, ...Array.from({ length: MAX_FILE_ROWS + 1 }, () => line))).problems)
      .toEqual(['The file has 3001 charges; FleetSuite takes 3000 at a time. Download a shorter stretch of dates.']);
  });
});

// ── A month's journal entry ─────────────────────────────────────────────────

const BMG: CardCompany = { code: 'BMG', name: 'BMG Fleet', subsidiaryId: '2' };
const OTHER: CardCompany = { code: '1084', name: '1084 Cool Springs', subsidiaryId: '3' };
const NOSUB: CardCompany = { code: 'NEW', name: 'New Co', subsidiaryId: null };
const CARD: CardAccount = { id: '900', number: '2100', name: 'Company card', type: 'credit_card', companies: ['BMG'] };
const ACCOUNTS = new Map<string, CardAccount>([
  ['610', { id: '610', number: '5100', name: 'Shop supplies', type: 'expense', companies: ['BMG', '1084', 'NEW'] }],
  ['620', { id: '620', number: null, name: 'Freight in', type: 'cost_of_goods_sold', companies: ['BMG'] }],
  ['640', { id: '640', number: '6400', name: 'Dues', type: 'expense', companies: ['1084'] }],
]);
const FACTS: CardEntryFacts = { company: BMG, cardAccount: CARD, accounts: ACCOUNTS };
const charge = (over: Partial<CardCharge> = {}): CardCharge => ({
  id: 'c1', date: '2027-01-03', description: 'ACME HARDWARE #1234', card: '1234', cents: 12550, accountId: '610', memo: null, ...over,
});
/** A purchase, money back from the same merchant, and a marketplace order: $147.60 onto the card. */
const CHARGES: CardCharge[] = [
  charge({ id: 'c2', date: '2027-01-07', description: 'ACME HARDWARE #5678', cents: -2000 }),
  charge({ memo: ' Shelf brackets ' }),
  charge({ id: 'c3', date: '2027-01-07', description: 'WIDGETS MKTPL*AB1CD2', card: null, cents: 4210, accountId: '620' }),
];
const work = (charges: CardCharge[] = CHARGES, facts: Partial<CardEntryFacts> = {}) => workOutCardEntry(charges, { ...FACTS, ...facts });
const problemsOf = (charges: CardCharge[] = CHARGES, facts: Partial<CardEntryFacts> = {}) => work(charges, facts).problems;

describe('workOutCardEntry', () => {
  it("puts each charge to its account and onto the card, money back the other way, oldest first", () => {
    const m1 = 'ACME HARDWARE #1234 · Jan 3 · card 1234 · Shelf brackets';
    const m2 = 'ACME HARDWARE #5678 · Jan 7 · card 1234';
    const m3 = 'WIDGETS MKTPL*AB1CD2 · Jan 7';
    expect(work()).toEqual({
      month: '2027-01',
      date: '2027-01-07',
      memo: '2100 Company card charges, January 2027, from FleetSuite',
      lines: [
        { accountId: '610', debitCents: 12550, creditCents: 0, memo: m1, chargeId: 'c1' },
        { accountId: '900', debitCents: 0, creditCents: 12550, memo: m1, chargeId: 'c1' },
        { accountId: '610', debitCents: 0, creditCents: 2000, memo: m2, chargeId: 'c2' },
        { accountId: '900', debitCents: 2000, creditCents: 0, memo: m2, chargeId: 'c2' },
        { accountId: '620', debitCents: 4210, creditCents: 0, memo: m3, chargeId: 'c3' },
        { accountId: '900', debitCents: 0, creditCents: 4210, memo: m3, chargeId: 'c3' },
      ],
      chargeCount: 3,
      netCents: 14760,
      totalCents: 18760,
      problems: [],
    });
    expect(CARD_CHARGE_RULE).toBe('card_charges@1');
  });

  it('balances: its debits are its credits are its total', () => {
    const w = work();
    const debits = w.lines.reduce((s, l) => s + l.debitCents, 0);
    const credits = w.lines.reduce((s, l) => s + l.creditCents, 0);
    expect([debits, credits]).toEqual([w.totalCents, w.totalCents]);
  });

  it('needs a company with a NetSuite subsidiary', () => {
    expect(problemsOf(CHARGES, { company: undefined })).toEqual(['Pick the company.']);
    const card = { ...CARD, companies: ['NEW'] };
    expect(problemsOf([charge()], { company: NOSUB, cardAccount: card }))
      .toEqual(["New Co has no NetSuite subsidiary in Books, so NetSuite can't take its journal entries."]);
  });

  it("needs the card's own account, a card account the company can use", () => {
    expect(problemsOf(CHARGES, { cardAccount: undefined })).toEqual(["Pick the card's account."]);
    expect(work(CHARGES, { cardAccount: undefined }).lines.map((l) => l.accountId)).toEqual(['610', '610', '620']);
    expect(problemsOf(CHARGES, { cardAccount: { ...CARD, type: 'expense' } })).toEqual(["2100 Company card isn't a card account BMG Fleet can use."]);
    expect(problemsOf(CHARGES, { cardAccount: { ...CARD, companies: ['1084'] } })).toEqual(["2100 Company card isn't a card account BMG Fleet can use."]);
    expect(problemsOf(CHARGES, { company: undefined, cardAccount: { ...CARD, type: 'bank' } }))
      .toEqual(['Pick the company.', "2100 Company card isn't a card account in the chart."]);
    expect(problemsOf(CHARGES, { cardAccount: { ...CARD, type: 'other_current_liability' } })).toEqual([]);
  });

  it(`takes one month of charges, ${MAX_CHARGES_PER_ENTRY} at most`, () => {
    expect(problemsOf([])).toEqual(['There are no charges to send.']);
    const many = (n: number) => Array.from({ length: n }, (_, i) => charge({ id: `c${String(i).padStart(3, '0')}`, cents: 100 }));
    expect(problemsOf(many(MAX_CHARGES_PER_ENTRY))).toEqual([]);
    expect(problemsOf(many(MAX_CHARGES_PER_ENTRY + 1))).toEqual(['One journal entry takes 250 charges at most, not 251.']);
    const two = work([charge({ id: 'b', date: '2027-02-01' }), charge({ id: 'a' })]);
    expect(two.problems).toEqual(['One journal entry takes one month of charges.']);
    expect([two.month, two.date]).toEqual(['2027-01', '2027-02-01']);
  });

  it(`sends nothing from before ${FIRST_SEND_MONTH}: the bookkeeper's journal entries have those months`, () => {
    expect(problemsOf([charge({ date: '2026-12-31' })]))
      .toEqual(["December 2026 is before January 2027: its card charges are on the bookkeeper's journal entries in NetSuite already."]);
    expect(problemsOf([charge({ date: '2027-01-01' })])).toEqual([]);
  });

  it('needs every charge coded, to an account the company can use that isn\'t the card', () => {
    expect(problemsOf([charge({ accountId: null }), charge({ id: 'c2' })])).toEqual(['One charge has no account yet.']);
    const two = work([charge({ accountId: null }), charge({ id: 'c2', accountId: null }), charge({ id: 'c3' })]);
    expect(two.problems).toEqual(['2 charges have no account yet.']);
    expect(two.lines.map((l) => l.chargeId)).toEqual(['c3', 'c3']);
    expect(problemsOf([charge({ accountId: '900' })])).toEqual(["The charge from ACME HARDWARE #1234 on Jan 3 can't go to the card's own account."]);
    expect(problemsOf([charge({ accountId: '999' })])).toEqual(["The charge from ACME HARDWARE #1234 on Jan 3 goes to an account BMG Fleet can't use."]);
    expect(problemsOf([charge({ accountId: '640' })])).toEqual(["The charge from ACME HARDWARE #1234 on Jan 3 goes to an account BMG Fleet can't use."]);
    expect(problemsOf([charge({ accountId: '640' })], { company: OTHER, cardAccount: { ...CARD, companies: ['1084'] } })).toEqual([]);
    expect(problemsOf([charge({ accountId: '999' })], { company: undefined }))
      .toEqual(['Pick the company.', "The charge from ACME HARDWARE #1234 on Jan 3 goes to an account FleetSuite can't use."]);
  });

  it('needs an amount on every charge, to the cent', () => {
    for (const cents of [0, 1.5, Number.NaN]) {
      const w = work([charge({ cents })]);
      expect(w.problems).toEqual(['The charge from ACME HARDWARE #1234 on Jan 3 has no amount.']);
      expect(w.lines).toEqual([]);
    }
  });
});

describe('chargeMemo', () => {
  it('names the merchant, the day, the card and anything typed, as NetSuite shows each line', () => {
    expect(chargeMemo(charge({ memo: '  Brackets for unit 12 ' }))).toBe('ACME HARDWARE #1234 · Jan 3 · card 1234 · Brackets for unit 12');
    expect(chargeMemo(charge({ card: null, memo: '  ' }))).toBe('ACME HARDWARE #1234 · Jan 3');
    expect(chargeMemo(charge({ description: 'A'.repeat(200), memo: 'm'.repeat(300) }))).toHaveLength(300);
  });
});

describe('the names and order', () => {
  it('names the month, the account, and the journal entry FleetSuite makes', () => {
    expect(monthName('2026-10')).toBe('October 2026');
    expect(monthName('2027-01')).toBe('January 2027');
    expect(accountName({ number: '5100', name: 'Shop supplies' })).toBe('5100 Shop supplies');
    expect(accountName({ number: null, name: 'Freight in' })).toBe('Freight in');
    expect(sendExternalId('6b0c1d2e-0000-4000-8000-000000000001')).toBe('fleetsuite-card-6b0c1d2e-0000-4000-8000-000000000001');
  });

  it('orders charges oldest first, then by id as the database does', () => {
    const list = [{ date: '2027-01-07', id: 'b' }, { date: '2027-01-03', id: 'z' }, { date: '2027-01-07', id: 'a' }, { date: '2027-01-07', id: 'a' }];
    expect([...list].sort(byDateThenId).map((c) => `${c.date} ${c.id}`)).toEqual(['2027-01-03 z', '2027-01-07 a', '2027-01-07 a', '2027-01-07 b']);
  });
});

describe('keptCharge', () => {
  it('reads a kept charge as the database gives it back, its amount as a number', () => {
    const row = {
      id: 'c1', charge_date: '2027-01-03', post_date: '2027-01-04', description: 'ACME HARDWARE #1234', merchant_key: 'ACME HARDWARE',
      category: 'Shopping', chase_type: 'Sale', cents: '12550', card: '1234', account_netsuite_id: '610', memo: null, remembered: true,
    };
    expect(keptCharge(row)).toEqual(charge());
    expect(keptCharge({ ...row, cents: -2000 }).cents).toBe(-2000);
  });
});

describe('netsuiteJournalEntry', () => {
  it('sends the lines in dollars, a debit or a credit each, under its External ID', () => {
    const w = work();
    expect(netsuiteJournalEntry(w, '2', 'send-1')).toEqual({
      subsidiaryId: '2',
      tranDate: '2027-01-07',
      memo: '2100 Company card charges, January 2027, from FleetSuite',
      externalId: 'fleetsuite-card-send-1',
      lines: [
        { accountId: '610', debit: 125.5, memo: w.lines[0].memo },
        { accountId: '900', credit: 125.5, memo: w.lines[0].memo },
        { accountId: '610', credit: 20, memo: w.lines[2].memo },
        { accountId: '900', debit: 20, memo: w.lines[2].memo },
        { accountId: '620', debit: 42.1, memo: w.lines[4].memo },
        { accountId: '900', credit: 42.1, memo: w.lines[4].memo },
      ],
    });
  });
});
