import { describe, it, expect } from 'vitest';
import { prettyPhone, reasonLabel, telHref, transcriptTurns } from './after-hours-calls';

describe('after-hours call helpers', () => {
  it('formats phone numbers and tel links', () => {
    expect(prettyPhone('+16365550142')).toBe('(636) 555-0142');
    expect(prettyPhone('555')).toBe('555');
    expect(telHref('(636) 555-0142')).toBe('tel:6365550142');
  });

  it('labels reasons', () => {
    expect(reasonLabel('quote')).toBe('Quote request');
    expect(reasonLabel('STATUS')).toBe('Job or estimate status');
    expect(reasonLabel(null)).toBe('Message');
    expect(reasonLabel('warranty')).toBe('Warranty');
  });

  it('splits a Retell transcript into speaker turns', () => {
    expect(transcriptTurns('Agent: Hi.\nUser: Need racks.\n\nnoise')).toEqual([
      { speaker: 'Assistant', text: 'Hi.' },
      { speaker: 'Caller', text: 'Need racks.' },
      { speaker: null, text: 'noise' },
    ]);
    expect(transcriptTurns(null)).toEqual([]);
  });
});
