import { describe, expect, it } from 'vitest';
import {
  ENTRY_MAX_CENTS, MODIFIERS, RECORD, achFileName, achText, addendaText, bankHolidays, buildAchFile, chicagoClock, dayText, effectiveDate,
  fileProblems, isBankDay, modifierFor, nextBankDay, originField, readAchFile, setupOf, setupProblems, type AchFileInput, type AchSetup,
  type SetupTyped,
} from '@/lib/ach-file';

// Made-up banks, IDs and accounts throughout.
const SETUP: AchSetup = {
  destination: '081999994',
  destinationName: 'FIRST BANK',
  origin: '1431234567',
  originName: 'BMG FLEET INSTALLATIONS',
  odfi: '08199999',
  companyName: 'BMG FLEET INSTAL',
  companyId: '1431234567',
  entryDescription: 'VENDOR PAY',
  secCode: 'CCD',
  addenda: true,
  balanced: false,
  lineEnding: 'crlf',
};

const OZARK = {
  routing: '123456780', account: '4455669012', type: 'checking' as const, cents: 141_240, name: 'OZARK HOSE & FITTING', reference: 'BILLPAY 512',
  bills: [{ number: 'B-4410', cents: 81_240 }, { number: 'B-4471', cents: 60_000 }],
};
const GATEWAY = {
  routing: '071200004', account: '88001234', type: 'savings' as const, cents: 245_000, name: 'Gateway Steel', reference: '513',
  bills: [{ number: 'GS-209', cents: 245_000 }],
};

const input = (over: Partial<AchFileInput> = {}, setup: Partial<AchSetup> = {}): AchFileInput => ({
  setup: { ...SETUP, ...setup },
  offset: null,
  createdDay: '2026-11-05',
  createdTime: '1430',
  modifier: 'A',
  effectiveDate: '2026-11-06',
  payees: [OZARK, GATEWAY],
  ...over,
});

const linesOf = (text: string) => text.split('\r\n').slice(0, -1);

describe('the ACH file', () => {
  it('is a file header, one batch of the payments with their addenda, its control, and the file control, filled to a block of ten', () => {
    const file = buildAchFile(input());
    expect(file.text.endsWith('\r\n')).toBe(true);
    const lines = linesOf(file.text);
    expect(lines).toHaveLength(10);
    expect(file.lines).toBe(10);
    for (const l of lines) expect(l).toHaveLength(RECORD);
    expect(lines.map((l) => l[0]).join('')).toBe('15676789' + '99');
    expect(lines[8]).toBe('9'.repeat(RECORD));
    expect(lines[9]).toBe('9'.repeat(RECORD));

    expect(lines[0]).toBe(
      '101 0819999941431234567' + '2611051430A094101' + 'FIRST BANK'.padEnd(23) + 'BMG FLEET INSTALLATIONS' + ' '.repeat(8),
    );
    expect(lines[1]).toBe(
      '5220BMG FLEET INSTAL' + ' '.repeat(20) + '1431234567CCDVENDOR PAY' + ' '.repeat(6) + '261106' + '   ' + '1' + '08199999' + '0000001',
    );
    expect(lines[2]).toBe(
      '622123456780' + '4455669012'.padEnd(17) + '0000141240' + 'BILLPAY 512'.padEnd(15) + 'OZARK HOSE & FITTING'.padEnd(22) + '  1' + '081999990000001',
    );
    expect(lines[3]).toBe('705' + 'RMR*IV*B-4410**812.40\\RMR*IV*B-4471**600.00\\'.padEnd(80) + '0001' + '0000001');
    expect(lines[4]).toBe(
      '632071200004' + '88001234'.padEnd(17) + '0000245000' + '513'.padEnd(15) + 'GATEWAY STEEL'.padEnd(22) + '  1' + '081999990000002',
    );
    expect(lines[5]).toBe('705' + 'RMR*IV*GS-209**2450.00\\'.padEnd(80) + '0001' + '0000002');
    // Entry hash: 12345678 + 07120000.
    expect(lines[6]).toBe('8220000004' + '0019465678' + '000000000000' + '000000386240' + '1431234567' + ' '.repeat(25) + '08199999' + '0000001');
    expect(lines[7]).toBe('9000001000001' + '00000004' + '0019465678' + '000000000000' + '000000386240' + ' '.repeat(39));
    expect(file).toMatchObject({ entryCount: 2, totalCents: 386_240, entryHash: '0019465678' });
  });

  it('ends with a debit to BMG\'s account for what it pays when First Bank wants it balanced', () => {
    const file = buildAchFile(input({ offset: { routing: '081999994', account: '7700012345', type: 'checking' } }, { balanced: true }));
    const lines = linesOf(file.text);
    expect(lines[1].slice(1, 4)).toBe('200');
    expect(lines[6]).toBe(
      '627081999994' + '7700012345'.padEnd(17) + '0000386240' + ' '.repeat(15) + 'BMG FLEET INSTALLATION' + '  0' + '081999990000003',
    );
    // 12345678 + 07120000 + 08199999, debits and credits each 3,862.40.
    expect(lines[7]).toBe('8200000005' + '0027665677' + '000000386240' + '000000386240' + '1431234567' + ' '.repeat(25) + '08199999' + '0000001');
    expect(lines[8]).toBe('9000001000001' + '00000005' + '0027665677' + '000000386240' + '000000386240' + ' '.repeat(39));
    expect(lines[9]).toBe('9'.repeat(RECORD));
    expect(file).toMatchObject({ entryCount: 2, totalCents: 386_240, entryHash: '0027665677', lines: 10 });
  });

  it('debits a savings account with 37', () => {
    const file = buildAchFile(input({ offset: { routing: '081999994', account: '7700012345', type: 'savings' } }, { balanced: true }));
    expect(linesOf(file.text)[6].slice(0, 3)).toBe('637');
  });

  it('leaves the addenda out when the setup says so', () => {
    const lines = linesOf(buildAchFile(input({}, { addenda: false })).text);
    expect(lines.map((l) => l[0]).join('')).toBe('15668999' + '99');
    expect(lines[2][78]).toBe('0');
    expect(lines[3][78]).toBe('0');
    expect(lines[4].slice(4, 10)).toBe('000002');
  });

  it('ends its lines the way the setup says', () => {
    const text = buildAchFile(input({}, { lineEnding: 'lf' })).text;
    expect(text.includes('\r')).toBe(false);
    expect(text.split('\n')).toHaveLength(11);
  });

  it('starts a second block once the records pass ten, and fills the last one', () => {
    const payees = Array.from({ length: 4 }, (_, i) => ({ ...GATEWAY, cents: 1000 + i }));
    const file = buildAchFile(input({ payees }));
    // 1 + 1 + 4 entries and 4 addenda + 1 + 1 = 12 records: two blocks.
    expect(file.lines).toBe(20);
    const lines = linesOf(file.text);
    expect(lines[11].slice(0, 13)).toBe('9000001000002');
    expect(lines.slice(12)).toEqual(Array(8).fill('9'.repeat(RECORD)));
  });

  it('fills no block when the records come to ten exactly', () => {
    const payees = Array.from({ length: 6 }, (_, i) => ({ ...GATEWAY, cents: 1000 + i }));
    const file = buildAchFile(input({ payees }, { addenda: false }));
    expect(file.lines).toBe(10);
    expect(linesOf(file.text)[9][0]).toBe('9');
    expect(linesOf(file.text)[9]).not.toBe('9'.repeat(RECORD));
  });

  it('starts a second block when the file control is the eleventh record', () => {
    const payees = Array.from({ length: 7 }, (_, i) => ({ ...GATEWAY, cents: 1000 + i }));
    const file = buildAchFile(input({ payees }, { addenda: false }));
    // 1 + 1 + 7 entries + 1 = 10 records before the file control.
    expect(file.lines).toBe(20);
    const lines = linesOf(file.text);
    expect(lines[10].slice(0, 13)).toBe('9000001000002');
    expect(lines.slice(11)).toEqual(Array(9).fill('9'.repeat(RECORD)));
  });

  it('keeps the last ten digits of the entry hash', () => {
    const payees = Array.from({ length: 140 }, () => ({ ...GATEWAY, routing: '729999997', cents: 100 }));
    const file = buildAchFile(input({ payees }, { addenda: false }));
    // 140 × 72999999 = 10219999860.
    expect(file.entryHash).toBe('0219999860');
  });

  it('takes the reference and name as the file can, in capitals', () => {
    const lines = linesOf(buildAchFile(input({ payees: [{ ...OZARK, reference: 'bp#512 (ach)', name: 'Ozark Hosé & Fitting, Inc. of St. Louis' }] })).text);
    expect(lines[2].slice(39, 54)).toBe('BP#512 ACH'.padEnd(15));
    expect(lines[2].slice(54, 76)).toBe('OZARK HOSE & FITTING, ');
  });

  it("isn't made with anything the file can't carry", () => {
    expect(() => buildAchFile(input({ payees: [] }))).toThrow('has no payments');
    const problems = fileProblems(input({
      payees: [
        { ...OZARK, routing: '123456789' },
        { ...OZARK, account: '123' },
        { ...OZARK, type: 'money_market' as never },
        { ...OZARK, cents: 0 },
        { ...OZARK, cents: ENTRY_MAX_CENTS + 1 },
        { ...OZARK, cents: 1.5 },
        { ...OZARK, name: '***' },
        { ...OZARK, routing: '12345678 0' },
        { ...OZARK, account: '1'.repeat(18) },
      ],
    }));
    expect(problems).toEqual([
      "Payment 1: the routing number isn't one.",
      "Payment 2: the account number isn't one.",
      "Payment 3: it's to a checking or savings account.",
      "Payment 4: the amount isn't one the file can carry.",
      "Payment 5: the amount isn't one the file can carry.",
      "Payment 6: the amount isn't one the file can carry.",
      'Payment 7: it needs the name on the account.',
      "Payment 8: the routing number isn't one.",
      "Payment 9: the account number isn't one.",
    ]);
    expect(fileProblems(input({ payees: [{ ...OZARK, account: '1'.repeat(17) }] }))).toEqual([]);
    expect(fileProblems(input({ payees: [{ ...OZARK, cents: ENTRY_MAX_CENTS }] }))).toEqual([]);
    const most = linesOf(buildAchFile(input({ payees: [{ ...OZARK, cents: ENTRY_MAX_CENTS }] })).text);
    expect(most.find((l) => l.startsWith('622'))!.slice(29, 39)).toBe('9999999999');
    expect(fileProblems(input({}, { balanced: true }))).toEqual(["A balanced file needs BMG's account the payments come from."]);
    expect(fileProblems(input({ offset: { routing: '081999994', account: '12', type: 'checking' } }, { balanced: true })))
      .toEqual(["A balanced file needs BMG's account the payments come from."]);
    expect(fileProblems(input({ modifier: 'a' }))).toEqual(['The file needs a letter or digit telling it apart from others made today.']);
    expect(fileProblems(input({ modifier: 'AB' }))).toEqual(['The file needs a letter or digit telling it apart from others made today.']);
    expect(fileProblems(input({ effectiveDate: '2026-11-07' }))).toEqual(['The file needs a banking day for First Bank to pay it.']);
    expect(fileProblems(input({ effectiveDate: '2026-11-6' }))).toEqual(['The file needs a banking day for First Bank to pay it.']);
    expect(fileProblems(input({ createdTime: '2460' }))).toEqual(['The file needs the day and time it was made.']);
    expect(fileProblems(input({ createdDay: '11/05/2026' }))).toEqual(['The file needs the day and time it was made.']);
    expect(fileProblems(input({}, { companyName: '' }))).toEqual(['Type the company name.']);
  });
});

describe('addendaText', () => {
  it('lists each bill and what is paid on it, as many as fit in 80 characters', () => {
    expect(addendaText([{ number: 'B-4410', cents: 81_240 }])).toBe('RMR*IV*B-4410**812.40\\');
    const bills = Array.from({ length: 5 }, (_, i) => ({ number: `INV-${1000 + i}`, cents: 12_345 }));
    const text = addendaText(bills);
    expect(text).toBe('RMR*IV*INV-1000**123.45\\RMR*IV*INV-1001**123.45\\RMR*IV*INV-1002**123.45\\');
    expect(text.length).toBeLessThanOrEqual(80);
  });

  it('takes a bill that ends at the 80th character, and none past it', () => {
    // Each segment is 16 characters and the bill number: 40 and 40 come to 80, 40 and 41 to 81.
    const first = { number: 'F'.repeat(24), cents: 10_000 };
    expect(addendaText([first, { number: 'S'.repeat(24), cents: 10_000 }])).toHaveLength(80);
    expect(addendaText([first, { number: 'S'.repeat(25), cents: 10_000 }])).toBe(`RMR*IV*${'F'.repeat(24)}**100.00\\`);
  });

  it("never carries the addenda's own marks in a bill number, and names a bill without one", () => {
    expect(addendaText([{ number: 'A*B\\C~D', cents: 100 }])).toBe('RMR*IV*A B C D**1.00\\');
    expect(addendaText([{ number: null, cents: 100 }, { number: '  ', cents: 200 }])).toBe('RMR*IV*BILL**1.00\\RMR*IV*BILL**2.00\\');
  });

  it('cuts a long bill number so its bill still fits', () => {
    const text = addendaText([{ number: 'X'.repeat(70), cents: 999_999_999_999 }]);
    expect(text).toBe(`RMR*IV*${'X'.repeat(30)}**9999999999.99\\`);
  });
});

describe('achText', () => {
  it('is capitals, without accents or what the file can\'t take, spaces closed up, cut to fit', () => {
    expect(achText('  Ozark   Hosé (St. Louis) ', 30)).toBe('OZARK HOSE ST. LOUIS');
    expect(achText("o'brien & sons, 4/5 #2-b", 30)).toBe("O'BRIEN & SONS, 4/5 #2-B");
    expect(achText('ABCDEFGHIJ KLM', 11)).toBe('ABCDEFGHIJ');
    expect(achText('***', 10)).toBe('');
  });
});

const typed = (over: Partial<SetupTyped> = {}): SetupTyped => ({ ...SETUP, ...over });

describe('setupProblems', () => {
  it('takes a setup as First Bank gave it', () => {
    expect(setupProblems(typed())).toEqual([]);
    expect(setupProblems(typed({ origin: '081999994', destination: '0819-9999-4', odfi: '0819 9999' }))).toEqual([]);
  });

  it('says what is wrong with each part', () => {
    expect(setupProblems(typed({ destination: '081999995' }))).toEqual([
      "First Bank's routing number: 081999995 isn't a routing number: its last digit doesn't check, so a digit is likely wrong.",
    ]);
    expect(setupProblems(typed({ destinationName: '' }))).toEqual(["Type the bank's name."]);
    expect(setupProblems(typed({ destinationName: 'F'.repeat(24) }))).toEqual(["The bank's name takes 23 characters at most: the file has room for no more."]);
    expect(setupProblems(typed({ destinationName: 'First Bank (MO)' }))).toEqual(["The bank's name takes letters, digits, spaces and & ' , . / # - only."]);
    for (const origin of ['14312345', '14312345678', '143123456*', 'A14312345', '']) {
      expect(setupProblems(typed({ origin }))).toEqual([
        "BMG's ACH ID with First Bank (the immediate origin) is the 10 characters, or 9 digits, First Bank gave BMG.",
      ]);
    }
    expect(setupProblems(typed({ originName: 'B'.repeat(24) }))).toEqual(["BMG's name for First Bank takes 23 characters at most: the file has room for no more."]);
    for (const odfi of ['0819999', '081999994', '0819999x', '']) {
      expect(setupProblems(typed({ odfi }))).toEqual(["The sending bank is the first 8 digits of First Bank's routing number, as First Bank gave them."]);
    }
    expect(setupProblems(typed({ companyName: 'BMG FLEET INSTALL' }))).toEqual(['The company name takes 16 characters at most: the file has room for no more.']);
    for (const companyId of ['', '14312345678', '143-123456']) {
      expect(setupProblems(typed({ companyId }))).toEqual([
        "BMG's company ID is the letters or digits First Bank gave BMG for ACH, 10 at most, often 1 and the EIN.",
      ]);
    }
    expect(setupProblems(typed({ entryDescription: 'VENDOR PAYS' }))).toEqual(['The description takes 10 characters at most: the file has room for no more.']);
    expect(setupProblems(typed({ secCode: 'WEB' }))).toEqual(['Pick CCD, paying businesses, or PPD, paying people, as First Bank set BMG up.']);
    expect(setupProblems(typed({ lineEnding: 'cr' }))).toEqual(['Pick how the file ends its lines.']);
  });
});

describe('setupOf', () => {
  it('keeps what was typed as the file has it', () => {
    expect(setupOf(typed({
      destination: '0819-9999-4', destinationName: ' first  bank ', origin: ' 1431234567 ', originName: 'bmg fleet', odfi: '0819 9999',
      companyName: 'bmg', companyId: 'abc123', entryDescription: 'vendor pay', secCode: 'PPD', addenda: false, balanced: true, lineEnding: 'lf',
    }))).toEqual({
      destination: '081999994', destinationName: 'FIRST BANK', origin: '1431234567', originName: 'BMG FLEET', odfi: '08199999',
      companyName: 'BMG', companyId: 'ABC123', entryDescription: 'VENDOR PAY', secCode: 'PPD', addenda: false, balanced: true, lineEnding: 'lf',
    });
  });

  it('pads a short company ID in the file, and sends 9-digit origins after a space', () => {
    const lines = linesOf(buildAchFile(input({}, { companyId: 'ABC123', origin: '081999994' })).text);
    expect(lines[0].slice(13, 23)).toBe(' 081999994');
    expect(lines[1].slice(40, 50)).toBe('ABC123    ');
    expect(lines[6].slice(44, 54)).toBe('ABC123    ');
    expect(originField('1431234567')).toBe('1431234567');
  });
});

describe('banking days', () => {
  it("are the Federal Reserve's: a Sunday holiday moves to Monday, a Saturday one doesn't", () => {
    expect([...bankHolidays(2026)].sort()).toEqual([
      '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
    ]);
    // July 4, 2026 is a Saturday: the Friday before is a banking day.
    expect(isBankDay('2026-07-03')).toBe(true);
    // 2022: Juneteenth and Christmas on a Sunday, observed the Monday after; 2023: New Year's Day.
    expect(bankHolidays(2022).has('2022-06-20')).toBe(true);
    expect(bankHolidays(2022).has('2022-12-26')).toBe(true);
    expect(bankHolidays(2023).has('2023-01-02')).toBe(true);
    expect(bankHolidays(2027).has('2027-05-31')).toBe(true);
    expect(bankHolidays(2027).has('2027-11-25')).toBe(true);
    expect(bankHolidays(2028).has('2027-12-31')).toBe(false);
  });

  it('are weekdays that aren\'t holidays', () => {
    expect(isBankDay('2026-11-06')).toBe(true);
    expect(isBankDay('2026-11-07')).toBe(false);
    expect(isBankDay('2026-11-08')).toBe(false);
    expect(isBankDay('2026-11-26')).toBe(false);
  });

  it('come next after a Friday on Monday, and step over a holiday', () => {
    expect(nextBankDay('2026-11-06')).toBe('2026-11-09');
    expect(nextBankDay('2026-11-25')).toBe('2026-11-27');
    expect(nextBankDay('2026-12-31')).toBe('2027-01-04');
  });
});

describe('effectiveDate', () => {
  it("is the run's day when that's a banking day after today", () => {
    expect(effectiveDate('2026-11-06', '2026-11-04')).toBe('2026-11-06');
    expect(effectiveDate('2026-11-05', '2026-11-04')).toBe('2026-11-05');
  });

  it('is the next banking day after today when the run is dated today or before', () => {
    expect(effectiveDate('2026-11-04', '2026-11-04')).toBe('2026-11-05');
    expect(effectiveDate('2026-10-30', '2026-11-06')).toBe('2026-11-09');
  });

  it('moves a run dated on a weekend or holiday to the banking day after', () => {
    expect(effectiveDate('2026-11-07', '2026-11-04')).toBe('2026-11-09');
    expect(effectiveDate('2026-11-26', '2026-11-20')).toBe('2026-11-27');
  });
});

describe('the clock at BMG', () => {
  it('is Central time, summer and winter, midnight as 00', () => {
    expect(chicagoClock(new Date('2026-07-01T04:59:00Z'))).toEqual({ day: '2026-06-30', time: '2359' });
    expect(chicagoClock(new Date('2026-12-01T06:00:00Z'))).toEqual({ day: '2026-12-01', time: '0000' });
    expect(chicagoClock(new Date('2026-12-01T05:59:00Z'))).toEqual({ day: '2026-11-30', time: '2359' });
  });
});

describe('modifierFor', () => {
  it('is A to Z, then 0 to 9, and nothing past the 36th', () => {
    expect(modifierFor(0)).toBe('A');
    expect(modifierFor(25)).toBe('Z');
    expect(modifierFor(26)).toBe('0');
    expect(modifierFor(35)).toBe('9');
    expect(MODIFIERS).toHaveLength(36);
    expect(modifierFor(36)).toBeNull();
    expect(modifierFor(-1)).toBeNull();
    expect(modifierFor(1.5)).toBeNull();
  });
});

describe('names and days', () => {
  it('names the file by company, day and letter', () => {
    expect(achFileName('BMG', '2026-11-06', 'A')).toBe('ACH-BMG-2026-11-06-A.txt');
    expect(achFileName('1084', '2026-11-06', '0')).toBe('ACH-1084-2026-11-06-0.txt');
    expect(achFileName('B M/G', '2026-11-06', 'B')).toBe('ACH-BMG-2026-11-06-B.txt');
    expect(achFileName('**', '2026-11-06', 'B')).toBe('ACH-BMG-2026-11-06-B.txt');
  });

  it('says a day as the page does', () => {
    expect(dayText('2026-11-06')).toBe('Friday, November 6');
  });
});

describe('readAchFile', () => {
  it('reads how a file starts, and only counts its payments', () => {
    const read = readAchFile(buildAchFile(input()).text);
    expect(read).toEqual({ setup: { ...SETUP }, offset: null, payments: 2 });
    const said = JSON.stringify(read);
    expect(said).not.toContain('4455669012');
    expect(said).not.toContain('88001234');
    expect(said).not.toContain('123456780');
  });

  it("reads BMG's account from a balanced file's offsetting debit, and a file without addenda", () => {
    const offset = { routing: '081999994', account: '7700012345', type: 'savings' as const };
    const setup = { ...SETUP, balanced: true, addenda: false, lineEnding: 'lf' as const, secCode: 'PPD' as const, origin: '081999994' };
    const read = readAchFile(buildAchFile(input({ offset }, setup)).text);
    expect(read).toEqual({ setup, offset, payments: 2 });
  });

  it('reads a file whose lines lost their trailing spaces, with a byte order mark', () => {
    const text = buildAchFile(input()).text.split('\r\n').map((l) => l.trimEnd()).join('\r\n');
    expect(readAchFile(`﻿${text}`)).toEqual({ setup: { ...SETUP }, offset: null, payments: 2 });
  });

  it('reads a company ID shorter than its field without the spaces after it', () => {
    expect(readAchFile(buildAchFile(input({}, { companyId: 'ABC123' })).text)).toMatchObject({ setup: { companyId: 'ABC123' } });
  });

  it("says what's wrong with a file it can't read", () => {
    expect(readAchFile('')).toEqual({ problem: "That isn't an ACH file: one starts with its file header, a line starting 1." });
    expect(readAchFile('Vendor,Amount\nOzark,1412.40')).toEqual({ problem: "That isn't an ACH file: one starts with its file header, a line starting 1." });
    expect(readAchFile(`1${'0'.repeat(RECORD)}`)).toEqual({ problem: "That isn't an ACH file: its lines are 94 characters at most." });
    expect(readAchFile(buildAchFile(input()).text.split('\r\n')[0])).toEqual({
      problem: "That ACH file has no batch in it, so how its payments are sent can't be read from it.",
    });
    const offset = { routing: '081999994', account: '7700012345', type: 'checking' as const };
    const lines = linesOf(buildAchFile(input({ offset }, { balanced: true })).text);
    const short = [...lines.slice(0, 6), `${lines[6].slice(0, 29)}0000000001${lines[6].slice(39)}`, ...lines.slice(7)].join('\n');
    expect(readAchFile(short)).toEqual({
      problem: "That file's debits aren't one debit to BMG's account for what it pays, so how First Bank takes it can't be copied.",
    });
    const twice = [...lines.slice(0, 7), lines[6], ...lines.slice(7)].join('\n');
    expect('problem' in readAchFile(twice)).toBe(true);
  });

  it('reads only the first batch', () => {
    const lines = linesOf(buildAchFile(input()).text);
    const more = [...lines.slice(0, 7), lines[1].replace('CCD', 'PPD'), lines[2], lines[6], ...lines.slice(7)].join('\r\n');
    expect(readAchFile(more)).toEqual({ setup: { ...SETUP }, offset: null, payments: 2 });
  });
});
