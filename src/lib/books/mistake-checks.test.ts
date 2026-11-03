import { describe, it, expect } from 'vitest';
import {
  addMonths, companyPicker, docLabel, findCreditsFarOff, findFarOff, findJournalFarOff, findJournalTwice, findMissing,
  findMistakes, findOddAccounts, findTwice, goneWhy, journalDoc, journalReversals, journalShape, keptItem, learnedFrom,
  mistakeSubject, mistakeView, ordinal, type KeptItem, type Learned, type MistakeDoc,
} from './mistake-checks';

// Every vendor, number and amount here is made up.
let nextId = 1000;
const doc = (over: Partial<MistakeDoc> & Pick<MistakeDoc, 'date' | 'total'>): MistakeDoc => ({
  netsuite_id: String(nextId++), type: 'VendBill', number: null, party: '501', name: 'Summit Supply Co.', voided: false,
  companies: ['BMG'], accounts: ['6420'], lines_known: true, ...over,
});
const BMG = companyPicker([]);
const nothingLearned = (): Learned => ({ accounts: new Map(), unwatched: new Set() });
const NAMES: Record<string, string> = {
  6420: '6420 Fuel', 6800: '6800 Rent', 6100: '6100 Shop Supplies', 6150: '6150 Small Tools', 6900: '6900 Depreciation',
  1650: '1650 Accumulated Depreciation', 2100: '2100 Accrued Expenses',
};
const accountName = (id: string) => NAMES[id] ?? `NetSuite account ${id}`;
/** The first of each month from `from` up to (not including) `to`. */
const months = (from: string, to: string) => {
  const out: string[] = [];
  for (let m = from; m < to; m = addMonths(m, 1)) out.push(m);
  return out;
};
/** A journal entry as the copy of NetSuite's ledger hands it over, each line [company, account, debit, credit, name]. */
const je = (date: string, lines: Array<[string, string, string, string, string?]>, number: string | null = null): MistakeDoc =>
  journalDoc({
    netsuite_id: String(nextId++), number, date,
    lines: lines.map(([company, account, debit, credit, entity]) => ({ company, account, entity: entity ?? null, debit, credit })),
  });
/** An entry to two accounts, and the same entry turned: every debit a credit. */
const accrual = (date: string, amount = '1250.00', number: string | null = null) =>
  je(date, [['BMG', '6150', amount, '0.00'], ['BMG', '2100', '0.00', amount]], number);
const turned = (date: string, amount = '1250.00', number: string | null = null) =>
  je(date, [['BMG', '6150', '0.00', amount], ['BMG', '2100', amount, '0.00']], number);
const kept = (over: Partial<KeptItem> & Pick<KeptItem, 'key' | 'kind' | 'date'>): KeptItem => ({
  company: 'BMG', party: '501', party_name: 'Summit Supply Co.', amount: null, strength: 0, why: 'Why.', docs: [], learn: null,
  state: 'open', how: null, learned: false, ...over,
});

describe('words', () => {
  it('names days of the month and documents as the page shows them', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st']);
    expect(docLabel({ type: 'VendBill', number: 'INV-20931', date: '2026-10-03' })).toBe('Bill INV-20931, Oct 3');
    expect(docLabel({ type: 'CardChrg', number: null, date: '2026-10-16' })).toBe('Card charge, Oct 16');
    expect(docLabel({ type: 'Journal', number: 'JE-1042', date: '2026-10-31' })).toBe('Journal entry JE-1042, Oct 31');
    expect(addMonths('2026-10-01', 3)).toBe('2027-01-01');
    expect(addMonths('2026-01-01', -1)).toBe('2025-12-01');
  });
});

describe('companyPicker', () => {
  it('takes the company the GL lines post to, else the one most of the vendor\'s documents do', () => {
    const docs = [
      doc({ date: '2026-01-05', total: '10.00', party: '7', companies: ['1084'] }),
      doc({ date: '2026-02-05', total: '10.00', party: '7', companies: ['1084'] }),
      doc({ date: '2026-03-05', total: '10.00', party: '7', companies: ['BMG'] }),
    ];
    const pick = companyPicker(docs);
    expect(pick(doc({ date: '2026-10-05', total: '10.00', party: '7', companies: [] }))).toBe('1084');
    expect(pick(doc({ date: '2026-10-05', total: '10.00', party: '7', companies: ['BMG', '1084'] }))).toBe('BMG');
    expect(pick(doc({ date: '2026-10-05', total: '10.00', party: '8', companies: [] }))).toBe('BMG');
  });
});

describe('findTwice', () => {
  it('flags two bills with the same vendor, amount and invoice number, as typed either way', () => {
    const a = doc({ date: '2026-10-03', total: '1284.50', number: 'INV-20931' });
    const b = doc({ date: '2026-10-09', total: '1284.50', number: 'inv 20931' });
    const [f, ...rest] = findTwice([a, b], BMG);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      key: `twice:${a.netsuite_id}+${b.netsuite_id}`, kind: 'twice', company: 'BMG', party: '501', date: '2026-10-09', amount: '1284.50', strength: 3,
      why: 'Two bills with the same amount and the same invoice number, INV-20931: one dated Oct 3, the other Oct 9.',
    });
    expect(f.docs.map((d) => d.label)).toEqual(['Bill INV-20931, Oct 3', 'Bill inv 20931, Oct 9']);
  });

  it('says when both are dated the same day, and leaves another amount, vendor or a voided one alone', () => {
    const a = doc({ date: '2026-10-03', total: '50.00', number: 'A1' });
    const b = doc({ date: '2026-10-03', total: '50.00', number: 'A1' });
    expect(findTwice([a, b], BMG)[0].why).toBe('Two bills with the same amount and the same invoice number, A1, both dated Oct 3.');
    expect(findTwice([a, doc({ date: '2026-10-04', total: '50.01', number: 'A1' })], BMG)).toEqual([]);
    expect(findTwice([a, doc({ date: '2026-10-04', total: '50.00', number: 'A1', party: '502' })], BMG)).toEqual([]);
    expect(findTwice([a, doc({ date: '2026-10-04', total: '50.00', number: 'A1', voided: true })], BMG)).toEqual([]);
    expect(findTwice([a, doc({ date: '2026-10-04', total: '50.00', number: null })], BMG)).toEqual([]);
  });

  it('flags a pair only when one of them is dated from September 1', () => {
    const old = [doc({ date: '2026-08-03', total: '50.00', number: 'A1' }), doc({ date: '2026-08-20', total: '50.00', number: 'A1' })];
    expect(findTwice(old, BMG)).toEqual([]);
    expect(findTwice([old[0], doc({ date: '2026-09-01', total: '50.00', number: 'A1' })], BMG)).toHaveLength(1);
  });

  it('flags a bill and a check or card charge for the same vendor and amount a week apart or less', () => {
    const bill = doc({ date: '2026-10-16', total: '736.40', number: 'T-88' });
    const card = doc({ date: '2026-10-18', total: '736.40', type: 'CardChrg' });
    const check = doc({ date: '2026-10-09', total: '736.40', type: 'Check', number: '10234' });
    const late = doc({ date: '2026-10-24', total: '736.40', type: 'CardChrg' });
    const found = findTwice([bill, card, check, late], BMG);
    expect(found.map((f) => [f.strength, f.why])).toEqual([
      [2, 'A bill and a card charge for the same amount, 2 days apart. It may have been entered both ways.'],
      [2, 'A bill and a check for the same amount, 7 days apart. It may have been entered both ways.'],
    ]);
  });

  it('flags two checks or card charges for the same payee and amount on one day, but not three, nor small ones', () => {
    const pair = [doc({ date: '2026-10-16', total: '64.99', type: 'CardChrg' }), doc({ date: '2026-10-16', total: '64.99', type: 'CardChrg' })];
    expect(findTwice(pair, BMG).map((f) => [f.strength, f.why])).toEqual([
      [1, 'Two card charges for the same amount on the same day. It may be one entered twice, or two purchases.'],
    ]);
    expect(findTwice([...pair, doc({ date: '2026-10-16', total: '64.99', type: 'CardChrg' })], BMG)).toEqual([]);
    const tolls = [doc({ date: '2026-10-16', total: '6.50', type: 'CardChrg' }), doc({ date: '2026-10-16', total: '6.50', type: 'CardChrg' })];
    expect(findTwice(tolls, BMG)).toEqual([]);
    const mixed = [doc({ date: '2026-10-16', total: '64.99', type: 'Check' }), doc({ date: '2026-10-16', total: '64.99', type: 'CardChrg' })];
    expect(findTwice(mixed, BMG)[0].why).toBe('A check and a card charge for the same amount on the same day. It may be one entered twice, or two purchases.');
  });

  it('flags bill credits and card refunds entered twice the same ways, among themselves', () => {
    const a = doc({ date: '2026-10-03', total: '150.00', number: 'CM-77', type: 'VendCred' });
    const b = doc({ date: '2026-10-09', total: '150.00', number: 'cm 77', type: 'VendCred' });
    const refund = doc({ date: '2026-10-11', total: '150.00', type: 'CardRfnd' });
    expect(findTwice([a, b, refund], BMG).map((f) => [f.key, f.strength, f.why])).toEqual([
      [`twice:${a.netsuite_id}+${b.netsuite_id}`, 3, 'Two bill credits with the same amount and the same number, CM-77: one dated Oct 3, the other Oct 9.'],
      [`twice:${b.netsuite_id}+${refund.netsuite_id}`, 2, 'A bill credit and a card refund for the same amount, 2 days apart. It may have been entered both ways.'],
    ]);
    const refunds = [doc({ date: '2026-10-16', total: '64.99', type: 'CardRfnd' }), doc({ date: '2026-10-16', total: '64.99', type: 'CardRfnd' })];
    expect(findTwice(refunds, BMG).map((f) => [f.strength, f.why])).toEqual([
      [1, 'Two card refunds for the same amount on the same day. It may be one entered twice, or two refunds.'],
    ]);
    expect(findTwice([...refunds, doc({ date: '2026-10-16', total: '64.99', type: 'CardRfnd' })], BMG)).toEqual([]);
    expect(findTwice([a, { ...b, voided: true }], BMG)).toEqual([]);
  });

  it('never pairs a credit or refund with a charge: one for a bill\'s amount is a return', () => {
    const credit = doc({ date: '2026-10-03', total: '150.00', number: 'CM-77', type: 'VendCred' });
    const refund = doc({ date: '2026-10-16', total: '64.99', type: 'CardRfnd' });
    const bill = doc({ date: '2026-10-03', total: '150.00', number: 'CM-77' });
    const card = doc({ date: '2026-10-16', total: '64.99', type: 'CardChrg' });
    expect(findTwice([credit, refund, bill, card], BMG)).toEqual([]);
    expect(findTwice([credit, doc({ date: '2026-10-05', total: '150.00', type: 'Check' })], BMG)).toEqual([]);
  });
});

describe('findJournalTwice', () => {
  it('flags two journal entries with the same lines within six days, whatever order their lines are in', () => {
    const a = je('2026-10-03', [['BMG', '6150', '412.18', '0.00'], ['BMG', '2100', '0.00', '412.18']], 'JE-1040');
    const b = je('2026-10-09', [['BMG', '2100', '0.00', '412.18'], ['BMG', '6150', '412.18', '0.00']], 'JE-1046');
    const [f, ...rest] = findJournalTwice([b, a], BMG);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      key: `twice:${a.netsuite_id}+${b.netsuite_id}`, kind: 'twice', company: 'BMG', party: null, party_name: null, date: '2026-10-09',
      amount: '412.18', strength: 2,
      why: 'Two journal entries with the same lines, to the same accounts for the same amounts: one dated Oct 3, the other Oct 9. It may be one entered twice.',
    });
    expect(f.docs.map((d) => d.label)).toEqual(['Journal entry JE-1040, Oct 3', 'Journal entry JE-1046, Oct 9']);
    expect(findJournalTwice([a, { ...b, date: '2026-10-03' }], BMG)[0].why)
      .toBe('Two journal entries with the same lines, to the same accounts for the same amounts, both dated Oct 3. It may be one entered twice.');
    // Its company is the one its lines post to; the key's ids in order whichever is dated first.
    const late = { ...accrual('2026-10-04'), companies: ['1084'], journal: accrual('2026-10-04').journal!.map((l) => ({ ...l, company: '1084' })) };
    const early = { ...late, netsuite_id: String(Number(late.netsuite_id) + 1), date: '2026-10-02' };
    expect(findJournalTwice([late, early], BMG)[0]).toMatchObject({ key: `twice:${late.netsuite_id}+${early.netsuite_id}`, company: '1084', date: '2026-10-04' });
  });

  it('leaves alone entries a week apart, with any line different, three that close, or before September', () => {
    const a = accrual('2026-10-03');
    expect(findJournalTwice([a, accrual('2026-10-09')], BMG)).toHaveLength(1);
    expect(findJournalTwice([a, accrual('2026-10-10')], BMG)).toEqual([]);
    expect(findJournalTwice([a, accrual('2026-10-04', '1250.01')], BMG)).toEqual([]);
    expect(findJournalTwice([a, je('2026-10-04', [['BMG', '6100', '1250.00', '0.00'], ['BMG', '2100', '0.00', '1250.00']])], BMG)).toEqual([]);
    expect(findJournalTwice([a, je('2026-10-04', [['1084', '6150', '1250.00', '0.00'], ['1084', '2100', '0.00', '1250.00']])], BMG)).toEqual([]);
    expect(findJournalTwice([a, je('2026-10-04', [['BMG', '6150', '1250.00', '0.00', '88'], ['BMG', '2100', '0.00', '1250.00']])], BMG)).toEqual([]);
    expect(findJournalTwice([a, accrual('2026-10-05'), accrual('2026-10-08')], BMG)).toEqual([]);
    expect(findJournalTwice([accrual('2026-08-03'), accrual('2026-08-05')], BMG)).toEqual([]);
    expect(findJournalTwice([accrual('2026-08-30'), accrual('2026-09-01')], BMG)).toHaveLength(1);
    // Lines that move nothing aren't lines; an entry of nothing isn't looked at.
    expect(findJournalTwice([a, je('2026-10-04', [...a.journal!.map((l): [string, string, string, string] => [l.company, l.account, l.debit, l.credit]), ['BMG', '6420', '0.00', '0.00']])], BMG)).toHaveLength(1);
    expect(findJournalTwice([je('2026-10-03', [['BMG', '6150', '0.00', '0.00']]), je('2026-10-04', [['BMG', '6150', '0.00', '0.00']])], BMG)).toEqual([]);
  });

  it('leaves alone a pair once another entry undoes one of them', () => {
    const a = accrual('2026-10-03');
    const extra = accrual('2026-10-05');
    expect(findJournalTwice([a, extra], BMG)).toHaveLength(1);
    expect(findJournalTwice([a, extra, turned('2026-10-20')], BMG)).toEqual([]);
  });
});

describe('journalReversals', () => {
  it('pairs each entry with the latest earlier one it undoes, every debit a credit', () => {
    const oct = accrual('2026-10-31');
    const back = turned('2026-11-01');
    const nov = accrual('2026-11-30');
    const back2 = je('2026-12-01', [['BMG', '2100', '1250.00', '0.00'], ['BMG', '6150', '0.00', '1250.00']]);
    const pairs = journalReversals([nov, back2, oct, back]);
    expect([oct, back, nov, back2].map((d) => pairs.get(d.netsuite_id)?.netsuite_id)).toEqual([back.netsuite_id, oct.netsuite_id, back2.netsuite_id, nov.netsuite_id]);

    // Two the same, then one turned: it takes the later of the two.
    const [first, second, undo] = [accrual('2026-10-03'), accrual('2026-10-05'), turned('2026-10-04')];
    const two = journalReversals([first, second, undo]);
    expect(two.get(first.netsuite_id)?.netsuite_id).toBe(undo.netsuite_id);
    expect(two.has(second.netsuite_id)).toBe(false);
    const after = journalReversals([first, second, turned('2026-10-06')]);
    expect(after.has(first.netsuite_id)).toBe(false);
    expect(after.has(second.netsuite_id)).toBe(true);
    // One turned once undoes one only; an entry that is its own turn, or a bill, undoes nothing.
    expect(journalReversals([first, second, turned('2026-10-06'), turned('2026-10-07')]).size).toBe(4);
    const own = je('2026-10-03', [['BMG', '6150', '50.00', '0.00'], ['BMG', '6150', '0.00', '50.00']]);
    expect(journalReversals([own, { ...own, netsuite_id: String(nextId++) }]).size).toBe(0);
    expect(journalReversals([doc({ date: '2026-10-03', total: '1250.00' }), turned('2026-10-04')]).size).toBe(0);
  });

  it('turns a debit into a credit line by line', () => {
    expect(journalShape(accrual('2026-10-03'), true)).toBe(journalShape(turned('2026-10-03')));
    expect(journalShape(accrual('2026-10-03'))).toBe('BMG|2100||0|125000;BMG|6150||125000|0');
    expect(journalShape({})).toBe('');
  });
});

describe('journalDoc', () => {
  it('reads a journal entry as the checks look at it: no vendor, its total its debits, its companies its lines\'', () => {
    expect(je('2026-10-31', [['BMG', '6150', '412.18', '0.00'], ['1084', '2100', '0.00', '400.00'], ['1084', '1300', '0.00', '12.18', '77']], 'JE-9'))
      .toMatchObject({ type: 'Journal', number: 'JE-9', date: '2026-10-31', party: null, name: null, total: '412.18', voided: false,
        companies: ['1084', 'BMG'], accounts: [], lines_known: true });
    expect(journalDoc({ netsuite_id: '5', number: null, date: '2026-10-31', lines: null })).toMatchObject({ total: '0.00', companies: [], journal: [] });
  });
});

describe('findFarOff', () => {
  const history = (amounts: string[], over: Partial<MistakeDoc> = {}) =>
    amounts.map((total, i) => doc({ date: `2025-${String((i % 12) + 1).padStart(2, '0')}-${String(Math.floor(i / 12) + 10)}`, total, ...over }));

  it('flags ten times a vendor\'s steady charges as a slipped decimal point', () => {
    const earlier = history(Array(11).fill('89.90'), { type: 'CardChrg', party: '610', name: 'Cloud Vault Storage' });
    const slip = doc({ date: '2026-10-12', total: '899.00', type: 'CardChrg', party: '610', name: 'Cloud Vault Storage' });
    const [f, ...rest] = findFarOff([...earlier, slip], BMG);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      key: `far_off:${slip.netsuite_id}`, kind: 'far_off', party: '610', party_name: 'Cloud Vault Storage', amount: '899.00', strength: 2,
      why: 'Their last 11 card charges were $89.90 each. This one is ten times that, which can be a slipped decimal point.',
    });
  });

  it('flags a tenth of steady charges, and says "about" when they vary a little', () => {
    const earlier = history(['1250.00', '1249.00', '1251.00', '1250.00', '1250.00', '1252.00', '1250.00']);
    const tenth = doc({ date: '2026-10-12', total: '125.00' });
    expect(findFarOff([...earlier, tenth], BMG)[0].why)
      .toBe('Their last 7 bills were about $1,250.00 each. This one is a tenth of that, which can be a slipped decimal point.');
  });

  it('flags more than twice the most a vendor has billed, from $500', () => {
    const earlier = history(['610.00', '905.00', '720.00', '640.00', '880.00', '700.00', '655.00'], { party: '620', name: 'Riverbend Electric' });
    const big = doc({ date: '2026-10-06', total: '2140.00', party: '620', name: 'Riverbend Electric' });
    expect(findFarOff([...earlier, big], BMG)[0]).toMatchObject({
      strength: 1,
      why: 'Their bills have run $610.00 to $905.00 since January 2025. This one is more than twice the most they\'ve billed.',
    });
    const trailer = doc({ date: '2026-10-07', total: '18450.00', party: '620' });
    expect(findFarOff([...earlier, trailer], BMG)[0].why).toContain('This one is more than 20 times the most they\'ve billed.');
    expect(findFarOff([...history(Array(6).fill('100.00')), doc({ date: '2026-10-07', total: '450.00' })], BMG)).toEqual([]);
    expect(findFarOff([...earlier, doc({ date: '2026-10-08', total: '1500.00', party: '620' })], BMG)).toEqual([]);
  });

  it('takes only six or more within 5% of each other as steady, and ten times or a tenth of them, the larger from $100, as a slip', () => {
    // Varying by a fifth isn't steady: ten times their middle is only far more than the most they've billed.
    const varied = history(['80.00', '100.00', '90.00', '110.00', '95.00', '85.00']);
    expect(findFarOff([...varied, doc({ date: '2026-10-12', total: '900.00' })], BMG)[0]).toMatchObject({
      strength: 1, why: 'Their bills have run $80.00 to $110.00 since January 2025. This one is more than eight times the most they\'ve billed.',
    });
    // Only the last three steady.
    const settled = history(['300.00', '500.00', '700.00', '89.90', '89.90', '89.90']);
    expect(findFarOff([...settled, doc({ date: '2026-10-12', total: '899.00' })], BMG)).toEqual([]);
    // Under $100 either way.
    expect(findFarOff([...history(Array(6).fill('8.99')), doc({ date: '2026-10-12', total: '89.90' })], BMG)).toEqual([]);
    expect(findFarOff([...history(Array(6).fill('89.90')), doc({ date: '2026-10-12', total: '8.99' })], BMG)).toEqual([]);
    // Fifteen times isn't a slipped decimal point.
    expect(findFarOff([...history(Array(6).fill('100.00')), doc({ date: '2026-10-12', total: '1500.00' })], BMG)[0]).toMatchObject({
      strength: 1, why: 'Their bills have all been $100.00 since January 2025. This one is 15 times the most they\'ve billed.',
    });
  });

  it('needs six earlier documents, and flags only what\'s dated from September 1', () => {
    expect(findFarOff([...history(Array(5).fill('89.90')), doc({ date: '2026-10-12', total: '899.00' })], BMG)).toEqual([]);
    expect(findFarOff([...history(Array(6).fill('89.90')), doc({ date: '2026-08-12', total: '899.00' })], BMG)).toEqual([]);
  });
});

describe('findCreditsFarOff', () => {
  it('flags a bill credit for more than the vendor billed in the year before it, from $100', () => {
    const before = [
      doc({ date: '2025-10-03', total: '900.00' }), // a year and a day before
      doc({ date: '2026-03-03', total: '120.00' }),
      doc({ date: '2026-09-20', total: '300.00', type: 'Check' }),
      doc({ date: '2026-09-25', total: '5000.00', voided: true }),
      doc({ date: '2026-09-26', total: '800.00', type: 'VendCred' }),
      doc({ date: '2026-10-04', total: '900.00' }), // after it
    ];
    const credit = doc({ date: '2026-10-03', total: '1250.00', type: 'VendCred', number: 'CM-9' });
    const [f, ...rest] = findCreditsFarOff([...before, credit], BMG);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      key: `far_off:${credit.netsuite_id}`, kind: 'far_off', company: 'BMG', party: '501', party_name: 'Summit Supply Co.', date: '2026-10-03',
      amount: '1250.00', strength: 1, docs: [{ label: 'Bill credit CM-9, Oct 3' }],
      why: 'Their bills and checks in the year before it came to $420.00, less than this credit. It may be for the wrong vendor, or have a slipped decimal point.',
    });
    expect(findCreditsFarOff([...before, doc({ date: '2026-10-03', total: '420.00', type: 'VendCred' })], BMG)).toEqual([]);
    expect(findCreditsFarOff([...before, doc({ date: '2026-10-03', total: '420.01', type: 'VendCred' })], BMG)).toHaveLength(1);
  });

  it('flags one from a vendor with nothing billed, and leaves alone a small, voided or early one, or a card refund', () => {
    const lone = doc({ date: '2026-10-03', total: '100.00', type: 'VendCred', party: '777' });
    expect(findCreditsFarOff([lone], BMG)[0].why)
      .toBe('No bills, checks or card charges from them in the year before it, so this credit has nothing to take back. It may be for the wrong vendor.');
    expect(findCreditsFarOff([doc({ date: '2026-10-03', total: '99.99', type: 'VendCred' })], BMG)).toEqual([]);
    expect(findCreditsFarOff([{ ...lone, voided: true }], BMG)).toEqual([]);
    expect(findCreditsFarOff([{ ...lone, party: null }], BMG)).toEqual([]);
    expect(findCreditsFarOff([{ ...lone, date: '2026-08-31' }], BMG)).toEqual([]);
    expect(findCreditsFarOff([{ ...lone, type: 'CardRfnd' }], BMG)).toEqual([]);
  });
});

describe('findJournalFarOff', () => {
  const depreciation = (date: string, amount: string) => je(date, [['BMG', '6900', amount, '0.00'], ['BMG', '1650', '0.00', amount]]);
  const year = months('2025-12-01', '2026-10-01').map((m) => depreciation(`${m.slice(0, 8)}28`, '1250.00'));

  it('flags a journal entry ten times what the entries to its accounts have steadily come to', () => {
    const slip = depreciation('2026-10-28', '12500.00');
    const [f, ...rest] = findJournalFarOff([...year, slip], BMG, accountName);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      key: `far_off:${slip.netsuite_id}`, kind: 'far_off', company: 'BMG', party: null, party_name: null, date: '2026-10-28', amount: '12500.00',
      strength: 2,
      why: 'The last 10 journal entries to 1650 Accumulated Depreciation and 6900 Depreciation were $1,250.00 each. '
        + 'This one is ten times that, which can be a slipped decimal point.',
    });
    expect(findJournalFarOff([...year.slice(0, -1), depreciation('2026-09-28', '1262.00'), depreciation('2026-10-28', '125.00')], BMG, accountName)[0].why)
      .toBe('The last 10 journal entries to 1650 Accumulated Depreciation and 6900 Depreciation were about $1,250.00 each. '
        + 'This one is a tenth of that, which can be a slipped decimal point.');
  });

  it('leaves alone other amounts, too few before, the same accounts the other way round, and one another undoes', () => {
    const slip = depreciation('2026-10-28', '12500.00');
    expect(findJournalFarOff([...year, depreciation('2026-10-28', '2500.00')], BMG, accountName)).toEqual([]);
    expect(findJournalFarOff([...year.slice(-5), slip], BMG, accountName)).toEqual([]);
    expect(findJournalFarOff([...year.slice(-6), slip], BMG, accountName)).toHaveLength(1);
    expect(findJournalFarOff([...year, depreciation('2026-08-29', '12500.00')], BMG, accountName)).toEqual([]);
    const otherWay = je('2026-10-28', [['BMG', '6900', '0.00', '12500.00'], ['BMG', '1650', '12500.00', '0.00'], ['BMG', '6900', '1.00', '0.00'], ['BMG', '1650', '0.00', '1.00']]);
    expect(findJournalFarOff([...year, otherWay], BMG, accountName)).toEqual([]);
    const undo = je('2026-10-30', [['BMG', '6900', '0.00', '12500.00'], ['BMG', '1650', '12500.00', '0.00']]);
    expect(findJournalFarOff([...year, slip, undo], BMG, accountName)).toEqual([]);
  });

  it('counts the accounts of an entry to more than three', () => {
    const spread = (date: string, n: number) => je(date, [
      ['BMG', '6900', String(1000 * n), '0.00'], ['BMG', '6420', String(200 * n), '0.00'], ['BMG', '6800', String(50 * n), '0.00'],
      ['BMG', '1650', '0.00', String(1250 * n)],
    ]);
    const steady = months('2026-03-01', '2026-10-01').map((m) => spread(`${m.slice(0, 8)}15`, 1));
    expect(findJournalFarOff([...steady, spread('2026-10-15', 10)], BMG, accountName)[0].why)
      .toBe('The last 7 journal entries to these 4 accounts were $1,250.00 each. This one is ten times that, which can be a slipped decimal point.');
  });
});

describe('findMissing', () => {
  const monthly = (from: string, to: string, over: Partial<MistakeDoc> = {}, day = '03') =>
    months(from, to).map((m) => doc({ date: `${m.slice(0, 8)}${day}`, total: '4200.00', party: '630', name: 'Westgate Properties', ...over }));

  it('flags a monthly charge a week past its usual day', () => {
    const docs = monthly('2025-01-01', '2026-10-01');
    const [f, ...rest] = findMissing(docs, '2026-10-24', nothingLearned(), []);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      key: 'missing:BMG:630:2026-10', kind: 'missing', company: 'BMG', party: '630', party_name: 'Westgate Properties', date: '2026-10-01',
      amount: '4200.00', learn: { party: '630', company: 'BMG' },
      why: 'Billed every month since January 2025, usually around the 3rd. Nothing for October yet, and it\'s the 24th.',
    });
    expect(f.docs.map((d) => d.label)).toEqual(['Last: Bill, Sep 3']);
    expect(findMissing(docs, '2026-10-09', nothingLearned(), [])).toEqual([]);
    expect(findMissing(docs, '2026-10-10', nothingLearned(), [])).toHaveLength(1);
    // A voided bill for October isn't October's charge.
    const voided = doc({ date: '2026-10-03', total: '4200.00', party: '630', voided: true });
    expect(findMissing([...docs, voided], '2026-10-24', nothingLearned(), [])).toHaveLength(1);
  });

  it('flags last month when nothing came for it, before this month\'s is due', () => {
    const docs = monthly('2025-03-01', '2026-09-01', {}, '28');
    expect(findMissing(docs, '2026-10-05', nothingLearned(), []).map((f) => [f.key, f.why])).toEqual([[
      'missing:BMG:630:2026-09',
      'Billed every month from March 2025 to August 2026, usually around the 28th. Nothing came for September 2026.',
    ]]);
  });

  it('says "charged" for card charges, keeps companies apart, and counts what the ledger has no company for yet', () => {
    const insurance = monthly('2025-03-01', '2026-10-01', { party: '640', name: 'Lakeview Insurance Agency', companies: ['1084'], type: 'CardChrg', total: '612.75' }, '15');
    const [f] = findMissing(insurance, '2026-10-24', nothingLearned(), []);
    expect(f).toMatchObject({ key: 'missing:1084:640:2026-10', company: '1084', amount: '612.75' });
    expect(f.why).toBe('Charged every month since March 2025, usually around the 15th. Nothing for October yet, and it\'s the 24th.');
    const arrived = doc({ date: '2026-10-16', total: '612.75', party: '640', companies: [], type: 'CardChrg' });
    expect(findMissing([...insurance, arrived], '2026-10-24', nothingLearned(), [])).toEqual([]);
    const forBmg = doc({ date: '2026-10-16', total: '612.75', party: '640', companies: ['BMG'], type: 'CardChrg' });
    expect(findMissing([...insurance, forBmg], '2026-10-24', nothingLearned(), []).map((x) => x.key)).toEqual(['missing:1084:640:2026-10']);
    // A vendor none of whose documents the ledger has put in a company yet is BMG's, as for the other checks.
    const unplaced = monthly('2025-03-01', '2026-10-01', { party: '641', companies: [] });
    expect(findMissing(unplaced, '2026-10-24', nothingLearned(), []).map((x) => x.key)).toEqual(['missing:BMG:641:2026-10']);
  });

  it('needs six months in a row, and leaves alone a charge no longer watched', () => {
    expect(findMissing(monthly('2026-04-01', '2026-10-01'), '2026-10-24', nothingLearned(), [])).toHaveLength(1);
    expect(findMissing(monthly('2026-05-01', '2026-10-01'), '2026-10-24', nothingLearned(), [])).toEqual([]);
    const learned = nothingLearned();
    learned.unwatched.add('BMG|630');
    expect(findMissing(monthly('2025-01-01', '2026-10-01'), '2026-10-24', learned, [])).toEqual([]);
  });

  it('keeps finding one already found until a document comes for its month', () => {
    // September never came, so by November there's no run of six months before it.
    const docs = monthly('2025-01-01', '2026-09-01');
    const item = kept({ key: 'missing:BMG:630:2026-09', kind: 'missing', date: '2026-09-01', party: '630', why: 'Old why.' });
    const found = findMissing(docs, '2026-11-20', nothingLearned(), [item]);
    expect(found.map((f) => [f.key, f.why])).toEqual([[
      'missing:BMG:630:2026-09',
      'Billed every month from January 2025 to August 2026, usually around the 3rd. Nothing came for September 2026.',
    ]]);
    // September's came late: that one's found no more, but now October's hasn't come.
    const late = doc({ date: '2026-09-30', total: '4200.00', party: '630' });
    expect(findMissing([...docs, late], '2026-11-20', nothingLearned(), [item]).map((f) => f.key)).toEqual(['missing:BMG:630:2026-10']);
    expect(findMissing(docs, '2026-11-20', nothingLearned(), [{ ...item, state: 'cleared', how: 'fine' }])).toEqual([]);
    expect(findMissing(docs, '2026-11-20', nothingLearned(), [{ ...item, state: 'cleared', how: 'fixed' }])).toHaveLength(1);
    // Nor once that monthly charge isn't watched.
    const unwatched = nothingLearned();
    unwatched.unwatched.add('BMG|630');
    expect(findMissing(docs, '2026-11-20', unwatched, [item])).toEqual([]);
  });

  it('flags nothing for a month before September', () => {
    expect(findMissing(monthly('2025-01-01', '2026-08-01'), '2026-08-24', nothingLearned(), [])).toEqual([]);
    expect(findMissing(monthly('2025-01-01', '2026-08-01'), '2026-09-05', nothingLearned(), [])).toEqual([]);
  });
});

describe('findOddAccounts', () => {
  const fuel = (n: number, over: Partial<MistakeDoc> = {}) =>
    Array.from({ length: n }, (_, i) => doc({ date: `2026-0${(i % 8) + 1}-${String(10 + Math.floor(i / 8))}`, total: '400.00', party: '650', name: 'Metro Fuel Services', ...over }));

  it('flags a line coded to an account the vendor\'s earlier documents never used', () => {
    const odd = doc({ date: '2026-10-14', total: '412.18', party: '650', name: 'Metro Fuel Services', accounts: ['6800'] });
    const [f, ...rest] = findOddAccounts([...fuel(23), odd], nothingLearned(), accountName, BMG);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      key: `odd_account:${odd.netsuite_id}`, kind: 'odd_account', party: '650', amount: '412.18', learn: { party: '650', accounts: ['6800'] },
      why: 'Coded to 6800 Rent. Their 23 earlier bills all went to 6420 Fuel.',
    });
  });

  it('names every usual account, up to three, and leaves alone a vendor coded to more', () => {
    const three = [...fuel(3), ...fuel(2, { accounts: ['6100'] }), ...fuel(1, { accounts: ['6150', '6420'] })];
    const odd = doc({ date: '2026-10-14', total: '412.18', party: '650', accounts: ['6800', '6420'] });
    expect(findOddAccounts([...three, odd], nothingLearned(), accountName, BMG)[0].why)
      .toBe('Coded to 6800 Rent. Their 6 earlier bills all went to 6100 Shop Supplies, 6150 Small Tools or 6420 Fuel.');
    const four = [...three, ...fuel(1, { accounts: ['7000'] })];
    expect(findOddAccounts([...four, odd], nothingLearned(), accountName, BMG)).toEqual([]);
  });

  it('needs five earlier documents with expense lines, and leaves alone what a super admin said is fine', () => {
    const odd = doc({ date: '2026-10-14', total: '412.18', party: '650', accounts: ['6800'] });
    expect(findOddAccounts([...fuel(4), ...fuel(3, { accounts: [] }), odd], nothingLearned(), accountName, BMG)).toEqual([]);
    const learned = nothingLearned();
    learned.accounts.set('650', new Set(['6800']));
    expect(findOddAccounts([...fuel(23), odd], learned, accountName, BMG)).toEqual([]);
  });

  it('looks at credits too, and counts them among the earlier documents: a credit goes back where their bills went', () => {
    const credit = doc({ date: '2026-10-01', total: '42.00', party: '650', name: 'Metro Fuel Services', type: 'VendCred', accounts: ['6800'] });
    const bill = doc({ date: '2026-10-20', total: '412.18', party: '650', accounts: ['6800'] });
    const refund = doc({ date: '2026-10-21', total: '12.00', party: '650', type: 'CardRfnd', accounts: ['6100'] });
    expect(findOddAccounts([...fuel(23), credit, bill, refund], nothingLearned(), accountName, BMG).map((f) => [f.key, f.why])).toEqual([
      [`odd_account:${credit.netsuite_id}`, 'Coded to 6800 Rent. Their 23 earlier bills all went to 6420 Fuel.'],
      [`odd_account:${refund.netsuite_id}`, 'Coded to 6100 Shop Supplies. Their 25 earlier bills and bill credits all went to 6420 Fuel or 6800 Rent.'],
    ]);
  });

  it('leaves alone documents whose lines the copy couldn\'t read', () => {
    const odd = doc({ date: '2026-10-14', total: '412.18', party: '650', accounts: [], lines_known: false });
    expect(findOddAccounts([...fuel(23), odd], nothingLearned(), accountName, BMG)).toEqual([]);
  });
});

describe('what clearing as fine teaches, and why one clears on its own', () => {
  it('learns accounts fine for a vendor and monthly charges not watched, only from items cleared as fine with it', () => {
    const items = [
      kept({ key: 'odd_account:1', kind: 'odd_account', date: '2026-10-14', party: '650', learn: { party: '650', accounts: ['6800'] }, state: 'cleared', how: 'fine', learned: true }),
      kept({ key: 'odd_account:2', kind: 'odd_account', date: '2026-10-14', party: '651', learn: { party: '651', accounts: ['6100'] }, state: 'cleared', how: 'fine', learned: false }),
      kept({ key: 'missing:1084:640:2026-10', kind: 'missing', date: '2026-10-01', learn: { party: '640', company: '1084' }, state: 'cleared', how: 'fine', learned: true }),
    ];
    const learned = learnedFrom(items);
    expect([...learned.accounts.entries()].map(([p, a]) => [p, [...a]])).toEqual([['650', ['6800']]]);
    expect([...learned.unwatched]).toEqual(['1084|640']);
  });

  it('says what changed in the copies', () => {
    const a = doc({ date: '2026-10-03', total: '1284.50', number: 'INV-1' });
    const b = doc({ date: '2026-10-09', total: '1284.50', number: 'INV-1' });
    const [twice] = findTwice([a, b], BMG);
    const item = kept({ ...twice, learn: null });
    const opts = { kept: [], accountName };
    expect(goneWhy(item, [a], opts)).toBe('Bill INV-1, Oct 9 is gone from NetSuite.');
    expect(goneWhy(item, [a, { ...b, voided: true }], opts)).toBe('Bill INV-1, Oct 9 was voided in NetSuite.');
    expect(goneWhy(item, [a, { ...b, total: '1248.50' }], opts)).toBe('Bill INV-1, Oct 9 is now $1,248.50, so they no longer match.');

    const rent = kept({ key: 'missing:BMG:630:2026-10', kind: 'missing', date: '2026-10-01', party: '630' });
    const came = doc({ date: '2026-10-18', total: '4200.00', party: '630', companies: [] });
    expect(goneWhy(rent, [came], opts)).toBe('The October bill came in, dated the 18th.');
    expect(goneWhy(rent, [], opts)).toBe('It no longer looks like a monthly charge.');

    const coded = doc({ date: '2026-10-14', total: '412.18', party: '650', accounts: ['6800'] });
    const odd = kept({ key: `odd_account:${coded.netsuite_id}`, kind: 'odd_account', date: coded.date, party: '650', party_name: 'Metro Fuel Services',
      docs: [{ netsuite_id: coded.netsuite_id, type: 'VendBill', number: null, date: coded.date, total: '412.18', label: 'Bill, Oct 14' }],
      learn: { party: '650', accounts: ['6800'] } });
    const fine = kept({ ...odd, key: 'odd_account:9', state: 'cleared', how: 'fine', learned: true });
    expect(goneWhy(odd, [coded], { kept: [odd, fine], accountName })).toBe('6800 Rent is fine for Metro Fuel Services now.');
    expect(goneWhy(odd, [{ ...coded, accounts: ['6420'] }], opts)).toBe('It\'s now coded to 6420 Fuel.');
  });
});

describe('why one about a credit or a journal entry clears on its own', () => {
  const opts = { kept: [], accountName };

  it('says when another journal entry undoes one, or their lines no longer match', () => {
    const a = accrual('2026-10-03', '1250.00', 'JE-1');
    const extra = accrual('2026-10-05', '1250.00', 'JE-2');
    const [twice] = findJournalTwice([a, extra], BMG);
    const item = kept({ ...twice, learn: null });
    expect(goneWhy(item, [a, extra, turned('2026-10-20', '1250.00', 'JE-3')], opts))
      .toBe('Journal entry JE-2, Oct 5 and journal entry JE-3, Oct 20 undo each other.');
    const recoded = { ...extra, journal: extra.journal!.map((l) => (l.account === '6150' ? { ...l, account: '6100' } : l)) };
    expect(goneWhy(item, [a, recoded], opts)).toBe('Their lines no longer match.');
    expect(goneWhy(item, [a, extra, accrual('2026-10-07')], opts)).toBe('They no longer look entered twice.');

    const depreciation = (date: string, amount: string) => je(date, [['BMG', '6900', amount, '0.00'], ['BMG', '1650', '0.00', amount]], 'JE-7');
    const slip = depreciation('2026-10-28', '12500.00');
    const year = months('2025-12-01', '2026-10-01').map((m) => depreciation(`${m.slice(0, 8)}28`, '1250.00'));
    const [far] = findJournalFarOff([...year, slip], BMG, accountName);
    const farItem = kept({ ...far, learn: null });
    expect(goneWhy(farItem, [...year, { ...slip, total: '1250.00' }], opts)).toBe('It\'s now $1,250.00.');
    expect(goneWhy(farItem, [...year.slice(-3), slip], opts)).toBe('It no longer looks far off the usual.');
  });

  it('says when a document is for another vendor now, or a credit no longer takes back more than they billed', () => {
    const credit = doc({ date: '2026-10-03', total: '1250.00', type: 'VendCred', number: 'CM-9' });
    const [far] = findCreditsFarOff([credit], BMG);
    const item = kept({ ...far, learn: null });
    expect(goneWhy(item, [{ ...credit, party: '502', name: 'Summit Tire' }], opts)).toBe('Bill credit CM-9, Oct 3 is for Summit Tire now.');
    expect(goneWhy(item, [{ ...credit, party: '502', name: null }], opts)).toBe('Bill credit CM-9, Oct 3 is for another vendor now.');
    expect(goneWhy(item, [credit, doc({ date: '2026-09-03', total: '1300.00' })], opts)).toBe('It no longer takes back more than they billed.');
    const card = doc({ date: '2026-10-12', total: '899.00', type: 'CardChrg', party: '610' });
    const cardItem = kept({ key: `far_off:${card.netsuite_id}`, kind: 'far_off', date: card.date, party: '610', docs: [{ netsuite_id: card.netsuite_id, type: 'CardChrg', number: null, date: card.date, total: '899.00', label: 'Card charge, Oct 12' }] });
    expect(goneWhy(cardItem, [card], opts)).toBe('It no longer looks far off their usual.');
  });
});

describe('findMistakes', () => {
  it('finds every kind in one look', () => {
    const twice = [doc({ date: '2026-10-03', total: '50.00', number: 'A1', party: '700' }), doc({ date: '2026-10-04', total: '50.00', number: 'A1', party: '700' })];
    const rent = months('2025-01-01', '2026-10-01').map((m) => doc({ date: `${m.slice(0, 8)}03`, total: '4200.00', party: '630' }));
    const found = findMistakes([...twice, ...rent], { today: '2026-10-24', kept: [], accountName });
    expect(found.map((f) => f.kind).sort()).toEqual(['missing', 'twice']);
  });

  it('looks at credits and journal entries in the same look', () => {
    const credit = doc({ date: '2026-10-03', total: '1250.00', type: 'VendCred', party: '777' });
    const journals = [accrual('2026-10-03'), accrual('2026-10-05')];
    const depreciation = (date: string, amount: string) => je(date, [['BMG', '6900', amount, '0.00'], ['BMG', '1650', '0.00', amount]]);
    const year = months('2025-12-01', '2026-10-01').map((m) => depreciation(`${m.slice(0, 8)}28`, '1250.00'));
    const found = findMistakes([credit, ...journals, ...year, depreciation('2026-10-28', '12500.00')], { today: '2026-10-29', kept: [], accountName });
    expect(found.map((f) => [f.kind, f.party_name ?? f.docs[0].type])).toEqual([
      ['twice', 'Journal'], ['far_off', 'Summit Supply Co.'], ['far_off', 'Journal'],
    ]);
  });
});

describe('mistakeSubject and the page', () => {
  const ref = (type: 'Journal' | 'VendBill', number: string | null) => ({ netsuite_id: '9', type, number, date: '2026-10-05', total: '1.00', label: 'x' });

  it('names the vendor, else the last journal entry it\'s about', () => {
    expect(mistakeSubject({ party_name: 'Metro Fuel Services', docs: [ref('Journal', 'JE-1')] })).toEqual({ name: 'Metro Fuel Services', journal: false });
    expect(mistakeSubject({ party_name: null, docs: [ref('Journal', 'JE-1'), ref('Journal', 'JE-2')] })).toEqual({ name: 'Journal entry JE-2', journal: true });
    expect(mistakeSubject({ party_name: null, docs: [ref('Journal', null)] })).toEqual({ name: 'Journal entry', journal: true });
    expect(mistakeSubject({ party_name: null, docs: [ref('Journal', 'JE-1'), ref('VendBill', 'B-1')] })).toEqual({ name: null, journal: false });
    expect(mistakeSubject({ party_name: null, docs: [ref('VendBill', 'B-1'), ref('Journal', 'JE-1')] })).toEqual({ name: null, journal: false });
    expect(mistakeSubject({ party_name: null, docs: [] })).toEqual({ name: null, journal: false });
    expect(mistakeSubject({ party_name: null, docs: 'nonsense' })).toEqual({ name: null, journal: false });
  });

  it('shows one about journal entries by the entry, linked to NetSuite\'s journal page', () => {
    const row = {
      id: '0b5c1d2e-3f40-4a51-8b62-7c83d94ea5f1', key: 'twice:41+42', kind: 'twice', company_id: 'c1', party_netsuite_id: null, party_name: null,
      doc_date: '2026-10-05', amount: '1250.00', strength: 2, why: 'Why.', docs: [ref('Journal', 'JE-1'), { ...ref('Journal', 'JE-2'), netsuite_id: '42', label: 'Journal entry JE-2, Oct 5' }],
      learn: null, state: 'open', cleared_how: null, learned: false, found_at: '2026-10-29T09:46:00Z',
    };
    const view = mistakeView(row, {
      companyCode: (id) => (id === 'c1' ? 'BMG' : null), accountName, names: new Map(), link: (type, id) => `ns/${type}/${id}`,
    });
    expect(view).toMatchObject({ party: 'Journal entry JE-2', cents: 125000, learnText: null });
    expect(view?.docs).toEqual([{ label: 'x', url: 'ns/Journal/9' }, { label: 'Journal entry JE-2, Oct 5', url: 'ns/Journal/42' }]);
  });
});

describe('keptItem', () => {
  it('reads a row, and leaves out one that doesn\'t read', () => {
    const code = (id: string) => (id === 'c1' ? 'BMG' as const : null);
    const row = {
      key: 'odd_account:12', kind: 'odd_account', company_id: 'c1', party_netsuite_id: '650', party_name: 'Metro Fuel Services', doc_date: '2026-10-14',
      amount: '412.18', strength: 0, why: 'Why.', docs: [], learn: { party: '650', accounts: ['6800'] }, state: 'cleared', cleared_how: 'fine', learned: true,
    };
    expect(keptItem(row, code)).toMatchObject({ key: 'odd_account:12', company: 'BMG', learn: { party: '650', accounts: ['6800'] }, how: 'fine', learned: true });
    expect(keptItem({ ...row, company_id: 'c2' }, code)).toBeNull();
    expect(keptItem({ ...row, kind: 'other' }, code)).toBeNull();
    expect(keptItem({ ...row, learn: { party: '650', company: 'XYZ' } }, code)?.learn).toBeNull();
  });
});
