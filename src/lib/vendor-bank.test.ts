// The rules for vendor bank numbers (Books part 59): what a routing number
// and an account number are, how an account number shows, the name the ACH
// file takes, notes kept free of account numbers, what's checked when the
// numbers are entered and on the call-back, and what a call-back that
// doesn't match says. Made-up numbers.
import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_TYPES, BANK_STATUSES, NAME_MAX, NOTE_MAX, SPOKE_WITH_MAX, WHERE_FROM, accountProblem, callBackProblems, digitsOf, entryProblems,
  isAccountType, maskedAccount, mismatchText, nameFor, nameProblem, noteProblem, numbersOf, readBackDiffers, routingProblem,
  type BankEntry, type CallBack,
} from './vendor-bank';

/** Eight digits with the ninth that makes them a routing number: weighted 3, 7, 1, they add up to a multiple of 10. */
const routing = (eight: string) => {
  const n = [...eight].map(Number);
  return eight + String((10 - ((3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + n[2] + n[5]) % 10)) % 10);
};

const ENTRY: BankEntry = {
  routing: '123456780', account: '1234 5678-9012', accountAgain: '123456789012', type: 'checking', name: 'Ozark Sign Supply',
  source: 'ACH form emailed by Dana at Ozark, 10/30',
};
const CALL: CallBack = { phone: '(636) 555-0142', spokeWith: 'Dana in accounts', routing: '123 456 780', account: '1234-5678-9012', type: 'checking' };

describe('digitsOf', () => {
  it('takes out spaces and dashes, and nothing else', () => {
    expect(digitsOf(' 1234 5678-90 ')).toBe('1234567890');
    expect(digitsOf('12\t34')).toBe('1234');
    expect(digitsOf('')).toBe('');
    expect(digitsOf('12a4')).toBeNull();
    expect(digitsOf('12.34')).toBeNull();
    expect(digitsOf('１２３４')).toBeNull();
  });
});

describe('routingProblem', () => {
  it('takes 9 digits whose last digit checks', () => {
    expect(routing('12345678')).toBe('123456780');
    for (const ok of ['123456780', '123-456-780', ' 123 456 780 ', routing('21111111'), routing('61111111')]) expect(routingProblem(ok)).toBeNull();
    expect(routingProblem('123456789')).toBe("123456789 isn't a routing number: its last digit doesn't check, so a digit is likely wrong.");
    expect(routingProblem('123456781')).toMatch(/last digit doesn't check/);
  });

  it('says what it needs when it is not', () => {
    expect(routingProblem('')).toBe('Type the routing number.');
    expect(routingProblem('  ')).toBe('Type the routing number.');
    expect(routingProblem('12345678O')).toBe('A routing number is digits only.');
    expect(routingProblem('12345678')).toBe('A routing number has 9 digits; that has 8.');
    expect(routingProblem('1234567801')).toBe('A routing number has 9 digits; that has 10.');
  });

  it('takes an ordinary bank, a thrift or an electronic one only', () => {
    const starts = (two: string) => routingProblem(routing(`${two}000000`));
    for (const ok of ['01', '05', '12', '21', '27', '32', '61', '66', '72']) expect(starts(ok)).toBeNull();
    for (const bad of ['00', '13', '20', '33', '60', '73', '80', '99']) {
      expect(starts(bad)).toBe(`${routing(`${bad}000000`)} isn't a routing number: they start 01 to 12, 21 to 32 or 61 to 72.`);
    }
  });
});

describe('accountProblem', () => {
  it('takes 4 to 17 digits, spaces and dashes aside', () => {
    for (const ok of ['1234', '12345678901234567', '1234-5678 9012']) expect(accountProblem(ok)).toBeNull();
    expect(accountProblem('')).toBe('Type the account number.');
    expect(accountProblem(' - ')).toBe('Type the account number.');
    expect(accountProblem('1234567x')).toBe('An account number is digits only.');
    expect(accountProblem('123')).toBe('An account number has 4 to 17 digits; that has 3.');
    expect(accountProblem('123456789012345678')).toBe('An account number has 4 to 17 digits; that has 18.');
  });

  it('never says the number back', () => {
    for (const typed of ['98765', '987654321098765432', '9876x5']) expect(accountProblem(typed) ?? '').not.toContain('9876');
  });
});

describe('how an account shows', () => {
  it('is the four digits it ends with', () => {
    expect(maskedAccount('6789')).toBe('•••• 6789');
  });

  it('names the types and where numbers are', () => {
    expect(ACCOUNT_TYPES).toEqual({ checking: 'Checking', savings: 'Savings' });
    expect(isAccountType('checking')).toBe(true);
    expect(isAccountType('savings')).toBe(true);
    expect(isAccountType('Checking')).toBe(false);
    expect(isAccountType(undefined)).toBe(false);
    expect(BANK_STATUSES.pending).toBe('Waiting for a call-back');
    expect(BANK_STATUSES.confirmed).toBe('Confirmed on a call-back');
  });
});

describe('the name on the account', () => {
  it('takes what the ACH file takes', () => {
    expect(NAME_MAX).toBe(22);
    expect(nameProblem(" O'Brien & Sons, Inc. ")).toBeNull();
    expect(nameProblem('A-1 Signs / Wraps #2')).toBeNull();
    expect(nameProblem('x'.repeat(22))).toBeNull();
    expect(nameProblem('x'.repeat(23))).toBe('The name on the account takes 22 characters at most: the ACH file has room for no more.');
    expect(nameProblem('  ')).toBe('Type the name on the account.');
    expect(nameProblem('O’Brien Signs')).toBe("The name on the account takes letters, digits, spaces and & ' , . / # - only.");
    expect(nameProblem('Signs (Ozark)')).toMatch(/only\.$/);
  });

  it('starts out as the vendor\'s name, cut to fit', () => {
    expect(nameFor('Ozark Sign Supply')).toBe('Ozark Sign Supply');
    expect(nameFor('Ozark Sign Supply Co. Inc')).toBe('Ozark Sign Supply Co.');
    expect(nameFor('Ozark Sign Supply Company')).toBe('Ozark Sign Supply Comp');
    expect(nameFor('  Café   Signs™ (MO) ')).toBe('Caf Signs MO');
    expect(nameFor('™™')).toBe('');
    for (const n of ['Ozark Sign Supply Co. Inc', 'Café Signs™', "Gateway Graphics & Wraps, L.L.C."]) expect(nameProblem(nameFor(n))).toBeNull();
  });
});

describe('noteProblem', () => {
  it('takes a note that says something, short enough', () => {
    expect(noteProblem(WHERE_FROM, ENTRY.source, NOTE_MAX)).toBeNull();
    expect(noteProblem(WHERE_FROM, '  ', NOTE_MAX)).toBe('Say where the numbers came from.');
    expect(noteProblem(WHERE_FROM, 'x'.repeat(300), NOTE_MAX)).toBeNull();
    expect(noteProblem(WHERE_FROM, `  ${'x'.repeat(300)}  `, NOTE_MAX)).toBeNull();
    expect(noteProblem(WHERE_FROM, 'x'.repeat(301), NOTE_MAX)).toBe('Say where the numbers came from in 300 characters at most.');
  });

  it('keeps account numbers out of it', () => {
    const out = "Leave account numbers out of where the numbers came from: they're only ever kept locked. A phone can go in as 636-555-0142.";
    expect(noteProblem(WHERE_FROM, 'Form says 123456 at the bank', NOTE_MAX)).toBe(out);
    expect(noteProblem(WHERE_FROM, 'Form says 12345 at the bank', NOTE_MAX)).toBeNull();
    expect(noteProblem(WHERE_FROM, 'Called 636-555-0142 and (636) 555-0199', NOTE_MAX)).toBeNull();
    // The account it's about, however it's spaced.
    expect(noteProblem(WHERE_FROM, 'It ends 1234 5678', NOTE_MAX, '12345678')).toBe(out);
    expect(noteProblem(WHERE_FROM, 'It ends 1234-56-78', NOTE_MAX, '12345678')).toBe(out);
    expect(noteProblem(WHERE_FROM, 'It ends 1234 5678', NOTE_MAX, '99995678')).toBeNull();
    expect(noteProblem(WHERE_FROM, 'It ends 1234 5678', NOTE_MAX, null)).toBeNull();
    expect(noteProblem(WHERE_FROM, 'It ends 1234 5678', NOTE_MAX, '')).toBeNull();
  });
});

describe('entryProblems', () => {
  it('passes a vendor\'s numbers typed right', () => {
    expect(entryProblems(ENTRY)).toEqual([]);
    expect(entryProblems({ ...ENTRY, type: 'savings', accountAgain: '1234-5678-9012' })).toEqual([]);
    expect(numbersOf(ENTRY)).toEqual({ routing: '123456780', account: '123456789012', type: 'checking' });
    expect(numbersOf({ ...ENTRY, routing: '123 456-780', type: 'savings' })).toEqual({ routing: '123456780', account: '123456789012', type: 'savings' });
  });

  it('says everything that\'s wrong, in order', () => {
    expect(entryProblems({ routing: '', account: '', accountAgain: '', type: '', name: '', source: '' })).toEqual([
      'Type the routing number.', 'Type the account number.', 'Pick checking or savings.', 'Type the name on the account.',
      'Say where the numbers came from.',
    ]);
    expect(entryProblems({ ...ENTRY, routing: '123456789' })).toEqual([expect.stringMatching(/last digit doesn't check/)]);
    expect(entryProblems({ ...ENTRY, name: 'x'.repeat(23) })).toEqual([expect.stringMatching(/22 characters at most/)]);
  });

  it('needs the account number typed the same twice', () => {
    expect(entryProblems({ ...ENTRY, accountAgain: '123456789013' })).toEqual(["The account number typed again doesn't match."]);
    expect(entryProblems({ ...ENTRY, accountAgain: '' })).toEqual(["The account number typed again doesn't match."]);
    // Not when the first one's wrong already.
    expect(entryProblems({ ...ENTRY, account: '12', accountAgain: '' })).toEqual(['An account number has 4 to 17 digits; that has 2.']);
  });

  it('keeps the account number out of where the numbers came from', () => {
    expect(entryProblems({ ...ENTRY, source: 'Dana read 1234 5678 9012 to me' })).toEqual([expect.stringMatching(/^Leave account numbers out/)]);
    expect(entryProblems({ ...ENTRY, account: '1234x', accountAgain: '1234x', source: 'Ends 1234x' })).toEqual(['An account number is digits only.']);
  });
});

describe('callBackProblems', () => {
  it('passes a call-back typed right', () => {
    expect(callBackProblems(CALL)).toEqual([]);
    expect(callBackProblems({ ...CALL, phone: '+1 636 555 0142' })).toEqual([]);
  });

  it('needs the number called, with its area code', () => {
    expect(callBackProblems({ ...CALL, phone: ' ' })).toEqual(['Type the phone you called them on.']);
    expect(callBackProblems({ ...CALL, phone: '555-0142' })).toEqual(['555-0142 is too short to be a phone number: type it with its area code.']);
    expect(callBackProblems({ ...CALL, phone: '636-555-014' })).toEqual([expect.stringMatching(/too short/)]);
    expect(callBackProblems({ ...CALL, phone: `636-555-0142 ${'x'.repeat(27)}` })).toEqual([]);
    expect(callBackProblems({ ...CALL, phone: `636-555-0142 ${'x'.repeat(28)}` })).toEqual(['The phone takes 40 characters at most.']);
  });

  it('needs who read them out, and what they read', () => {
    expect(SPOKE_WITH_MAX).toBe(100);
    expect(callBackProblems({ ...CALL, spokeWith: '' })).toEqual(['Say who read them out.']);
    expect(callBackProblems({ ...CALL, spokeWith: 'x'.repeat(101) })).toEqual(['Say who read them out in 100 characters at most.']);
    expect(callBackProblems({ ...CALL, spokeWith: 'Dana, extension 1234567' })).toEqual([expect.stringMatching(/^Leave account numbers out of who read them out/)]);
    // The account they read, short as it may be, stays out of it too; not when it isn't an account number.
    expect(callBackProblems({ ...CALL, account: '40712', spokeWith: 'Dana, 407 12' })).toEqual([expect.stringMatching(/^Leave account numbers out of who read them out/)]);
    expect(callBackProblems({ ...CALL, account: '407x', spokeWith: 'Dana, 407x' })).toEqual(['An account number is digits only.']);
    expect(callBackProblems({ ...CALL, routing: '12345678', account: '12', type: 'money market' })).toEqual([
      'A routing number has 9 digits; that has 8.', 'An account number has 4 to 17 digits; that has 2.', 'Pick checking or savings, as they said.',
    ]);
  });
});

describe('a call-back read back', () => {
  const entered = numbersOf(ENTRY);

  it('matches what was entered, however it was typed', () => {
    expect(readBackDiffers(entered, CALL)).toEqual([]);
  });

  it('says which parts don\'t', () => {
    expect(readBackDiffers(entered, { ...CALL, routing: routing('12345679') })).toEqual(['routing number']);
    expect(readBackDiffers(entered, { ...CALL, account: '123456789013' })).toEqual(['account number']);
    expect(readBackDiffers(entered, { ...CALL, account: '1234567890' })).toEqual(['account number']);
    expect(readBackDiffers(entered, { ...CALL, type: 'savings' })).toEqual(['checking or savings']);
    expect(readBackDiffers(entered, { routing: routing('12345679'), account: '9999', type: 'savings' }))
      .toEqual(['routing number', 'account number', 'checking or savings']);
  });

  it('says so with the tries left', () => {
    expect(mismatchText(['account number'], 2))
      .toBe("The account number they read doesn't match what was entered, so nothing changed: 2 more tries before they're refused.");
    expect(mismatchText(['routing number', 'account number'], 1))
      .toBe("The routing number and account number they read don't match what was entered, so nothing changed: one more try before they're refused.");
    expect(mismatchText(['routing number', 'account number', 'checking or savings'], 2))
      .toBe("The routing number, account number and checking or savings they read don't match what was entered, so nothing changed: 2 more tries before they're refused.");
  });
});
