import { describe, it, expect } from 'vitest';
import { bounceDetail, isTemporaryBounce, bounceNextStep, bounceIsAmbiguous, recipientsLabel, allRecipients } from './email-bounce';

const GENERAL = "The recipient's email provider sent a general bounce message.";

describe('bounceDetail', () => {
  it('keeps the subtype next to the type — it names the actual reason', () => {
    expect(bounceDetail({ bounce: { type: 'Transient', subType: 'MessageTooLarge', message: 'Too big' } }))
      .toBe('Transient (MessageTooLarge): Too big');
  });

  it('falls back to whichever parts exist', () => {
    expect(bounceDetail({ bounce: { type: 'Permanent', message: 'No such user' } })).toBe('Permanent: No such user');
    expect(bounceDetail({ failed: { reason: 'Invalid recipient' } })).toBe('Invalid recipient');
    expect(bounceDetail({})).toBeNull();
    expect(bounceDetail(undefined)).toBeNull();
  });
});

describe('bounceNextStep', () => {
  it('does not blame the address on a transient bounce — the 2026-09-23 Central Air alert', () => {
    const step = bounceNextStep('bounced', `Transient: ${GENERAL}`);
    expect(step).toMatch(/address is probably fine/);
    expect(step).not.toMatch(/Fix the address/);
    expect(bounceNextStep('bounced', `Transient (General): ${GENERAL}`)).toBe(step);
    expect(isTemporaryBounce('Undetermined (Undetermined): x')).toBe(true);
  });

  it('still says fix the address when the bounce is permanent or unexplained', () => {
    expect(bounceNextStep('bounced', 'Permanent (General): No such user')).toBe('Fix the address and resend.');
    expect(bounceNextStep('bounced', null)).toBe('Fix the address and resend.');
    expect(bounceNextStep('failed', 'The email could not be handed to the delivery service')).toBe('Fix the address and resend.');
  });

  it('never tells anyone to fix the address of a spam complaint', () => {
    expect(bounceNextStep('complained', null)).not.toMatch(/address/);
  });
});

describe('several recipients — Resend does not say which one bounced', () => {
  const to = ['tstewart@sunsetford.com'];
  const copies = ['vfleahman@bmgfleet.com', 'cgeorge@bmgfleet.com'];

  it('will not pin a bounce on the customer when a teammate was copied — the 2026-09-23 Sunset Ford alert', () => {
    expect(bounceIsAmbiguous('bounced', to, copies)).toBe(true);
    const step = bounceNextStep('bounced', `Transient (General): ${GENERAL}`, { ambiguous: true });
    expect(step).toMatch(/customer still got it/);
    expect(step).not.toMatch(/Fix the address/);
  });

  it('still blames the one address when it was the only one', () => {
    expect(bounceIsAmbiguous('bounced', to, null)).toBe(false);
    expect(bounceIsAmbiguous('bounced', to, [])).toBe(false);
    expect(bounceIsAmbiguous('bounced', to, ['TSTEWART@sunsetford.com'])).toBe(false);
  });

  it('never calls a failed hand-off ambiguous — it reached nobody', () => {
    expect(bounceIsAmbiguous('failed', to, copies)).toBe(false);
  });

  it('counts two To addresses as ambiguous too', () => {
    expect(bounceIsAmbiguous('bounced', ['info@staycool-hvac.com', 'jwolfe@staycool-hvac.com'], null)).toBe(true);
  });

  it('labels the To line, then the copies, without repeats', () => {
    expect(recipientsLabel(to, copies))
      .toBe('tstewart@sunsetford.com (copied: vfleahman@bmgfleet.com, cgeorge@bmgfleet.com)');
    expect(recipientsLabel(to, ['tstewart@sunsetford.com'])).toBe('tstewart@sunsetford.com');
    expect(allRecipients([' a@x.com '], ['A@x.com', 'b@y.com'])).toEqual(['a@x.com', 'b@y.com']);
  });
});
