import { describe, expect, it } from 'vitest';
import { guessNameFromEmail, isOwnAddress, unknownRecipients } from './new-recipients';

describe('unknownRecipients', () => {
  it('returns only addresses the record does not have, case-insensitively', () => {
    expect(unknownRecipients(
      ['Fleet@Acme.com', 'new.buyer@acme.com'],
      ['fleet@acme.com', null, ''],
    )).toEqual(['new.buyer@acme.com']);
  });

  it('never offers BMG addresses', () => {
    expect(unknownRecipients(['craig@bmgfleet.com', 'x@acme.com'], [])).toEqual(['x@acme.com']);
    expect(isOwnAddress('someone@mail.bmgfleet.com')).toBe(true);
    expect(isOwnAddress('someone@notbmgfleet.com')).toBe(false);
  });

  it('dedupes and keeps typed order', () => {
    expect(unknownRecipients(['b@x.com', 'a@x.com', 'B@x.com'], [])).toEqual(['b@x.com', 'a@x.com']);
  });
});

describe('guessNameFromEmail', () => {
  it('turns first.last into a name', () => {
    expect(guessNameFromEmail('john.smith@acme.com')).toBe('John Smith');
    expect(guessNameFromEmail('mary_ann-jones@acme.com')).toBe('Mary Ann Jones');
    expect(guessNameFromEmail('john.smith+fleet@acme.com')).toBe('John Smith');
  });

  it('leaves shared inboxes and initials blank', () => {
    expect(guessNameFromEmail('ap@acme.com')).toBe('');
    expect(guessNameFromEmail('accounts.payable@acme.com')).toBe('');
    expect(guessNameFromEmail('jsmith@acme.com')).toBe('');
    expect(guessNameFromEmail('j.smith@acme.com')).toBe('');
    expect(guessNameFromEmail('fleet2@acme.com')).toBe('');
  });
});
