import { describe, it, expect } from 'vitest';
import { bounceDetail, isTemporaryBounce, bounceNextStep } from './email-bounce';

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
