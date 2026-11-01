import { describe, expect, it } from 'vitest';
import {
  CHECK_NUMBER_MAX, DEFAULT_LAYOUT, NUDGE_MAX, SAMPLE_CHECK, STUB_LINES, addressLines, amountInFigures, amountInWords, checkDate,
  checkNumbersText, checkStateOf, checkToPrint, dollarsInWords, isCheckPosition, layoutOf, layoutProblems, layoutText, nextCheckNumber,
  nudgeText, numberTaken, numberingProblems, payeeName, printedCheckOf, stockText, storedCheck, stubLines, type CheckNow,
} from './check-printing';

describe('the amount in words', () => {
  it('says whole dollars the way a check does', () => {
    expect(dollarsInWords(0)).toBe('zero');
    expect(dollarsInWords(7)).toBe('seven');
    expect(dollarsInWords(13)).toBe('thirteen');
    expect(dollarsInWords(19)).toBe('nineteen');
    expect(dollarsInWords(20)).toBe('twenty');
    expect(dollarsInWords(42)).toBe('forty-two');
    expect(dollarsInWords(99)).toBe('ninety-nine');
    expect(dollarsInWords(100)).toBe('one hundred');
    expect(dollarsInWords(101)).toBe('one hundred one');
    expect(dollarsInWords(110)).toBe('one hundred ten');
    expect(dollarsInWords(999)).toBe('nine hundred ninety-nine');
    expect(dollarsInWords(1000)).toBe('one thousand');
    expect(dollarsInWords(1412)).toBe('one thousand four hundred twelve');
    expect(dollarsInWords(20_005)).toBe('twenty thousand five');
    expect(dollarsInWords(300_000)).toBe('three hundred thousand');
    expect(dollarsInWords(1_000_000)).toBe('one million');
    expect(dollarsInWords(1_000_001)).toBe('one million one');
    expect(dollarsInWords(10_000_000)).toBe('ten million');
    expect(dollarsInWords(12_345_678)).toBe('twelve million three hundred forty-five thousand six hundred seventy-eight');
    expect(dollarsInWords(999_999_999)).toBe('nine hundred ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine');
  });

  it("won't say what isn't a whole number of dollars a check can say", () => {
    for (const bad of [-1, 1.5, 1_000_000_000, Number.NaN]) expect(() => dollarsInWords(bad)).toThrow(/isn't a whole number of dollars/);
  });

  it('puts the cents over 100 and starts with a capital', () => {
    expect(amountInWords(141240)).toBe('One thousand four hundred twelve and 40/100');
    expect(amountInWords(245000)).toBe('Two thousand four hundred fifty and 00/100');
    expect(amountInWords(5)).toBe('Zero and 05/100');
    expect(amountInWords(99)).toBe('Zero and 99/100');
    expect(amountInWords(100)).toBe('One and 00/100');
    expect(amountInWords(1_000_000_000)).toBe('Ten million and 00/100');
    for (const bad of [-1, 10.5]) expect(() => amountInWords(bad)).toThrow(/isn't a whole number of cents/);
  });

  it('fills the box from the left and writes the day month first', () => {
    expect(amountInFigures(141240)).toBe('**1,412.40');
    expect(amountInFigures(5)).toBe('**0.05');
    expect(amountInFigures(1_000_000_000)).toBe('**10,000,000.00');
    expect(checkDate('2026-11-06')).toBe('11/06/2026');
    expect(checkDate('2027-01-31')).toBe('01/31/2027');
  });
});

describe('what goes on the check', () => {
  it("makes it out to NetSuite's Print on Check As when there is one", () => {
    expect(payeeName('Ozark Hose and Fitting LLC', 'Ozark Hose & Fitting')).toBe('Ozark Hose and Fitting LLC');
    expect(payeeName('  ', 'Ozark Hose & Fitting')).toBe('Ozark Hose & Fitting');
    expect(payeeName(null, 'Gateway Steel')).toBe('Gateway Steel');
  });

  it("puts the vendor's address in lines for the window, at most four", () => {
    expect(addressLines({ street: '1200 Industrial Dr, Suite 4', city: 'Springfield', state: 'MO', zip: '65802' }))
      .toEqual(['1200 Industrial Dr', 'Suite 4', 'Springfield, MO 65802']);
    expect(addressLines({ street: '88 Mill St', city: '', state: '', zip: '' })).toEqual(['88 Mill St']);
    expect(addressLines({ street: '', city: 'Springfield', state: '', zip: '65802' })).toEqual(['Springfield 65802']);
    expect(addressLines({ street: 'A, B, C, D', city: 'Springfield', state: 'MO', zip: '65802' })).toEqual(['A', 'B', 'C', 'D']);
    expect(addressLines(null)).toEqual([]);
    expect(addressLines(undefined)).toEqual([]);
  });

  it('lists each bill on the stub, or as many as fit and the rest on one line', () => {
    const bills = Array.from({ length: 20 }, (_, i) => ({ number: `B-${i + 1}`, date: '2026-10-01', cents: 100 * (i + 1) }));
    expect(stubLines(bills.slice(0, 2))).toEqual([
      { text: 'Bill B-1', date: '10/01/2026', cents: 100 },
      { text: 'Bill B-2', date: '10/01/2026', cents: 200 },
    ]);
    expect(stubLines([{ number: null, date: null, cents: 5 }])).toEqual([{ text: 'Bill', date: '', cents: 5 }]);
    // As many as fit are each listed; one more and the last two go on one line.
    expect(stubLines(bills.slice(0, STUB_LINES)).map((l) => l.text)).toEqual(bills.slice(0, STUB_LINES).map((b) => `Bill ${b.number}`));
    const over = stubLines(bills.slice(0, STUB_LINES + 1));
    expect(over).toHaveLength(STUB_LINES);
    expect(over[STUB_LINES - 1]).toEqual({ text: 'and 2 more bills', date: '', cents: 100 * STUB_LINES + 100 * (STUB_LINES + 1) });
    const many = stubLines(bills, 5);
    expect(many.map((l) => l.text)).toEqual(['Bill B-1', 'Bill B-2', 'Bill B-3', 'Bill B-4', 'and 16 more bills']);
    expect(many.reduce((s, l) => s + l.cents, 0)).toBe(bills.reduce((s, b) => s + b.cents, 0));
  });

  it("has a made-up check for the test page that adds up", () => {
    expect(SAMPLE_CHECK.bills.reduce((s, b) => s + b.cents, 0)).toBe(SAMPLE_CHECK.cents);
  });
});

describe('where it lands', () => {
  it('keeps a layout as it was set, and the default for anything else', () => {
    expect(layoutOf(null)).toEqual(DEFAULT_LAYOUT);
    expect(layoutOf({ check_position: 'bottom', right_sixteenths: -3, down_sixteenths: 16 })).toEqual({ position: 'bottom', right: -3, down: 16 });
    expect(layoutOf({ check_position: 'sideways', right_sixteenths: 17, down_sixteenths: 1.5 })).toEqual(DEFAULT_LAYOUT);
    expect(isCheckPosition('middle')).toBe(true);
    expect(isCheckPosition('Middle')).toBe(false);
  });

  it('says what is wrong with a layout', () => {
    expect(layoutProblems({ position: 'top', right: NUDGE_MAX, down: -NUDGE_MAX })).toEqual([]);
    expect(layoutProblems({ position: 'left' as never, right: 0, down: 0 })).toEqual(['Pick where the check is on the sheet: top, middle or bottom.']);
    expect(layoutProblems({ position: 'top', right: 17, down: 0.5 })).toEqual([
      'Move it right or left by a whole number of sixteenths of an inch, 16 at most (one inch).',
      'Move it down or up by a whole number of sixteenths of an inch, 16 at most (one inch).',
    ]);
    expect(layoutProblems({ position: 'top', right: 0, down: -17 })).toHaveLength(1);
  });

  it('says how far it moves in the plainest fraction', () => {
    expect(nudgeText({ right: 0, down: 0 })).toBe('not moved');
    expect(nudgeText({ right: 1, down: 0 })).toBe('1/16 inch right');
    expect(nudgeText({ right: -2, down: 0 })).toBe('1/8 inch left');
    expect(nudgeText({ right: 0, down: 4 })).toBe('1/4 inch down');
    expect(nudgeText({ right: 6, down: -8 })).toBe('3/8 inch right, 1/2 inch up');
    expect(nudgeText({ right: 12, down: -3 })).toBe('3/4 inch right, 3/16 inch up');
    expect(nudgeText({ right: -16, down: 16 })).toBe('1 inch left, 1 inch down');
  });

  it("says where a bank account's checks print in a line", () => {
    expect(layoutText(DEFAULT_LAYOUT)).toBe('Check at the top of the sheet · print not moved');
    expect(layoutText({ position: 'middle', right: 2, down: 0 })).toBe('Check in the middle of the sheet · print moved 1/8 inch right');
    expect(layoutText({ position: 'bottom', right: -1, down: -4 })).toBe('Check at the bottom of the sheet · print moved 1/16 inch left, 1/4 inch up');
  });
});

describe('check numbers', () => {
  it("suggests one past the highest used on the account", () => {
    expect(nextCheckNumber([])).toBeNull();
    expect(nextCheckNumber([1048, 1050, 1049])).toBe(1051);
    expect(nextCheckNumber([0, -4])).toBeNull();
    expect(nextCheckNumber([CHECK_NUMBER_MAX])).toBeNull();
    expect(nextCheckNumber([CHECK_NUMBER_MAX - 1])).toBe(CHECK_NUMBER_MAX);
  });

  it('takes the numbers on the stock in order, each one free', () => {
    const used = new Set([1050, 1052]);
    expect(numberingProblems(1053, 3, used)).toEqual([]);
    expect(numberingProblems(1051, 1, used)).toEqual([]);
    expect(numberingProblems(1051, 2, used)).toEqual([
      'Check 1052 was used already on this bank account. Check the number printed on the first check in the printer.',
    ]);
    expect(numberingProblems(1049, 4, used)).toEqual([
      'Checks 1050 and 1052 were used already on this bank account. Check the number printed on the first check in the printer.',
    ]);
    expect(numberingProblems(1050, 3, new Set([1050, 1051, 1052]))[0]).toMatch(/^Checks 1050, 1051 and 1052 were used already/);
    expect(numberingProblems(1, 0, used)).toEqual(['Tick the checks to print.']);
    for (const bad of [0, -5, 10.5, CHECK_NUMBER_MAX + 1, Number.NaN]) {
      expect(numberingProblems(bad, 1, used)).toEqual(['Type the number printed on the first check in the printer: a whole number from 1 to 99,999,999.']);
    }
    expect(numberingProblems(CHECK_NUMBER_MAX, 1, used)).toEqual([]);
    expect(numberingProblems(CHECK_NUMBER_MAX - 1, 3, used)).toEqual(['3 checks from 99999998 go past 99,999,999.']);
  });
});

describe("NetSuite's bill payment", () => {
  const expected = { vendorId: '31', cents: 141240 };
  const now = (over: Partial<CheckNow> = {}): CheckNow => ({ number: '', toBePrinted: true, voided: false, vendorId: '31', totalCents: 141240, ...over });

  it("prints only a check that's still To Be Printed, for the vendor and amount FleetSuite made it", () => {
    expect(checkStateOf(expected, now())).toEqual({ state: 'to_print' });
    expect(checkStateOf(expected, now({ number: 'To Print' }))).toEqual({ state: 'to_print' });
    expect(checkStateOf(expected, undefined)).toEqual({ state: 'refuse', why: "NetSuite doesn't have this bill payment any more." });
    expect(checkStateOf(expected, now({ voided: true }))).toEqual({ state: 'refuse', why: "It's voided in NetSuite." });
    for (const over of [{ vendorId: '47' }, { vendorId: null }, { totalCents: 141239 }, { totalCents: null }]) {
      expect(checkStateOf(expected, now(over))).toEqual({
        state: 'refuse', why: "NetSuite's bill payment isn't what FleetSuite made any more: look at it in NetSuite.",
      });
    }
  });

  it('says when it was printed in NetSuite already, and refuses one taken off To Be Printed without a number', () => {
    expect(checkStateOf(expected, now({ toBePrinted: false, number: ' 1047 ' }))).toEqual({ state: 'printed_there', number: 1047 });
    // Still with the number of a check FleetSuite gave it that didn't print right: it's FleetSuite's to number again.
    expect(checkStateOf(expected, now({ toBePrinted: false, number: '1051' }), [1049, 1051])).toEqual({ state: 'to_print' });
    expect(checkStateOf(expected, now({ toBePrinted: false, number: '1052' }), [1049, 1051])).toEqual({ state: 'printed_there', number: 1052 });
    expect(checkStateOf(expected, now({ toBePrinted: false, number: '1051', voided: true }), [1051])).toEqual({ state: 'refuse', why: "It's voided in NetSuite." });
    for (const number of ['', 'ACH', '0', '123456789', '10-47']) {
      expect(checkStateOf(expected, now({ toBePrinted: false, number }))).toEqual({
        state: 'refuse', why: "It isn't To Be Printed in NetSuite any more, and NetSuite gives it no check number.",
      });
    }
  });

  it("knows NetSuite took a number when it has the number and isn't To Be Printed", () => {
    expect(numberTaken(1050, now({ toBePrinted: false, number: '1050' }))).toBe(true);
    expect(numberTaken(1050, now({ toBePrinted: true, number: '1050' }))).toBe(false);
    expect(numberTaken(1050, now({ toBePrinted: false, number: '1049' }))).toBe(false);
    expect(numberTaken(1050, now({ toBePrinted: false, number: '1050', voided: true }))).toBe(false);
    expect(numberTaken(1050, undefined)).toBe(false);
  });
});

describe('a check as it is kept and printed again', () => {
  const made = {
    number: 1052, date: '2026-11-06', vendorName: 'Ozark Hose & Fitting', printOnCheckAs: ' Ozark Hose and Fitting LLC ',
    address: { street: '1200 Industrial Dr, Suite 4', city: 'Springfield', state: 'MO', zip: '65802' }, cents: 141240, memo: ' November run ',
    accountName: '10100 Operating Checking', bills: [{ number: 'B-4410', date: '2026-10-06', cents: 81240 }, { number: null, date: null, cents: 60000 }],
  };

  it("is made out to NetSuite's Print on Check As or the vendor's name, with the vendor's address and each bill", () => {
    expect(checkToPrint(made)).toEqual({
      number: 1052, date: '2026-11-06', payee: 'Ozark Hose and Fitting LLC', address: ['1200 Industrial Dr', 'Suite 4', 'Springfield, MO 65802'],
      cents: 141240, memo: 'November run', vendorName: 'Ozark Hose & Fitting', accountName: '10100 Operating Checking',
      bills: [{ number: 'B-4410', date: '2026-10-06', cents: 81240 }, { number: null, date: null, cents: 60000 }],
    });
    expect(checkToPrint({ ...made, printOnCheckAs: null, address: null, memo: null })).toMatchObject({ payee: 'Ozark Hose & Fitting', address: [], memo: '' });
  });

  it('keeps what was printed, and prints the same again with its number', () => {
    const printed = checkToPrint(made);
    const kept = storedCheck(printed);
    expect(kept).toEqual({
      date: '2026-11-06', payee: 'Ozark Hose and Fitting LLC', address: ['1200 Industrial Dr', 'Suite 4', 'Springfield, MO 65802'], cents: 141240,
      memo: 'November run', vendor_name: 'Ozark Hose & Fitting', account_name: '10100 Operating Checking',
      bills: [{ number: 'B-4410', date: '2026-10-06', cents: 81240 }, { number: null, date: null, cents: 60000 }],
    });
    // Kept as JSON, as the database gives it back.
    expect(printedCheckOf(1052, JSON.parse(JSON.stringify(kept)))).toEqual(printed);
    expect(printedCheckOf(1060, kept)).toEqual({ ...printed, number: 1060 });
    expect(printedCheckOf(1052, { ...kept, memo: undefined, vendor_name: null, account_name: 7 })).toEqual({
      ...printed, memo: '', vendorName: 'Ozark Hose and Fitting LLC', accountName: '',
    });
    expect(printedCheckOf(1052, { ...kept, address: ['1200 Industrial Dr', 7, null], bills: [{ number: 4410, date: 'Oct 6', cents: 100 }] })).toMatchObject({
      address: ['1200 Industrial Dr'], bills: [{ number: null, date: null, cents: 100 }],
    });
  });

  it("prints nothing again from what isn't a whole check", () => {
    const kept = storedCheck(checkToPrint(made));
    for (const bad of [
      null, undefined, 'check', [], { ...kept, date: '11/06/2026' }, { ...kept, date: undefined }, { ...kept, cents: -1 }, { ...kept, cents: 1.5 },
      { ...kept, cents: '141240' }, { ...kept, payee: '  ' }, { ...kept, payee: null }, { ...kept, bills: null }, { ...kept, address: 'Springfield' },
      { ...kept, bills: [{ number: 'B-1', cents: -5 }] }, { ...kept, bills: [null] }, { ...kept, bills: [{ number: 'B-1' }] },
    ]) {
      expect(printedCheckOf(1052, bad)).toBeNull();
    }
  });
});

describe('check numbers in a sentence', () => {
  it('says one, a run of them, or each', () => {
    expect(checkNumbersText([])).toBe('no checks');
    expect(checkNumbersText([1050])).toBe('check 1050');
    expect(checkNumbersText([1052, 1050, 1051])).toBe('checks 1050 to 1052');
    expect(checkNumbersText([1050, 1051])).toBe('checks 1050 to 1051');
    expect(checkNumbersText([1054, 1050, 1052])).toBe('checks 1050, 1052 and 1054');
    expect(checkNumbersText([1050, 1050, 1051])).toBe('checks 1050 to 1051');
  });

  it('says where the stock goes: the first on top, or each in order when they skip', () => {
    expect(stockText([])).toBe('');
    expect(stockText([1050])).toBe('Put check 1050 on top of the stock in the printer.');
    expect(stockText([1052, 1050, 1051])).toBe('Put check 1050 on top of the stock in the printer.');
    expect(stockText([1060, 1050, 1051])).toBe('Put checks 1050, 1051 and 1060 in the printer in that order, check 1050 on top.');
  });
});
