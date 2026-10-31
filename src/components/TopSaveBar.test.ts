import { describe, expect, it } from 'vitest';
import { stickyHeaderOffset, twoLineLabel, LEAVE_WITHOUT_SAVING } from './TopSaveBar';

describe('stickyHeaderOffset', () => {
  it('tucks the bar under a sticky header', () => {
    expect(stickyHeaderOffset({ offsetHeight: 61 }, 'sticky')).toBe(61);
  });
  it('pins to the very top when the header scrolls away (admin view-as)', () => {
    expect(stickyHeaderOffset({ offsetHeight: 61 }, 'static')).toBe(0);
  });
  it('pins to the very top with no header (split-screen pane)', () => {
    expect(stickyHeaderOffset(null, null)).toBe(0);
  });
});

describe('twoLineLabel', () => {
  it('keeps "without saving" together so the phone button is two lines, not three', () => {
    expect(twoLineLabel(LEAVE_WITHOUT_SAVING)).toBe('Leave without\u00a0saving');
  });
  it('leaves a one-word label alone', () => {
    expect(twoLineLabel('Close')).toBe('Close');
  });
});
