import { describe, it, expect } from 'vitest';
import {
  classifyViewer, summarizeViews, viewLabel, isReopen, neverOpenedDue,
  REOPEN_QUIET_DAYS, NEVER_OPENED_DAYS, SCANNER_WINDOW_SECONDS,
} from './quote-views';

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const NOW = Date.parse('2026-09-11T12:00:00Z');
const ago = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe('classifyViewer', () => {
  it('calls a browser a person, and says which signal decided', () => {
    expect(classifyViewer(CHROME, { secondsSinceSent: 4000 }))
      .toEqual({ kind: 'human', signal: 'browser_user_agent' });
  });

  it('will not call a link scanner a customer — the whole point of the table', () => {
    for (const ua of [
      'Mozilla/5.0 (compatible; ProofpointURLDefense)',
      'Mimecast Link Scanner',
      'Mozilla/5.0 (compatible; BingPreview/1.0b)',
      'Microsoft Office Word 2016',
      'Slackbot-LinkExpanding 1.0',
    ]) {
      expect(classifyViewer(ua, { secondsSinceSent: 9000 }).kind).toBe('bot');
    }
  });

  it('treats a scripted fetch as a machine', () => {
    expect(classifyViewer('curl/8.4.0').kind).toBe('bot');
    expect(classifyViewer('python-requests/2.31').kind).toBe('bot');
    expect(classifyViewer('Go-http-client/2.0').kind).toBe('bot');
  });

  it('has no user agent to believe', () => {
    expect(classifyViewer('')).toEqual({ kind: 'bot', signal: 'no_user_agent' });
    expect(classifyViewer(null).kind).toBe('bot');
  });

  it('refuses anything that does not even claim to be a browser', () => {
    expect(classifyViewer('SomeInternalTool/2.1').signal).toBe('non_browser_user_agent');
  });

  it('is UNVERIFIED, not human, seconds after the send — that is when scanners fire', () => {
    const c = classifyViewer(CHROME, { secondsSinceSent: 12 });
    expect(c.kind).toBe('unverified');
    expect(c.signal).toBe('within_scanner_window');
  });

  it('believes the same browser once the scanner window has passed', () => {
    expect(classifyViewer(CHROME, { secondsSinceSent: SCANNER_WINDOW_SECONDS }).kind).toBe('human');
  });

  it('believes a browser when the send time is unknown rather than withholding forever', () => {
    expect(classifyViewer(CHROME, {}).kind).toBe('human');
    expect(classifyViewer(CHROME, { secondsSinceSent: null }).kind).toBe('human');
  });
});

describe('summarizeViews', () => {
  const views = [
    { viewed_at: ago(9), viewer_kind: 'bot' },
    { viewed_at: ago(8), viewer_kind: 'human' },
    { viewed_at: ago(1), viewer_kind: 'human' },
    { viewed_at: ago(1), viewer_kind: 'unverified' },
  ];

  it('counts only people, and never blends machines into the number', () => {
    const s = summarizeViews(views);
    expect(s.humanCount).toBe(2);
    expect(s.machineCount).toBe(2);
  });

  it('finds the first and last human look regardless of row order', () => {
    const s = summarizeViews([...views].reverse());
    expect(s.firstHumanAt).toBe(ago(8));
    expect(s.lastHumanAt).toBe(ago(1));
  });

  it('is all zeroes and nulls when only machines have fetched it', () => {
    const s = summarizeViews([{ viewed_at: ago(2), viewer_kind: 'bot' }]);
    expect(s).toEqual({ humanCount: 0, firstHumanAt: null, lastHumanAt: null, machineCount: 1 });
  });

  it('handles no views at all', () => {
    expect(summarizeViews([]).humanCount).toBe(0);
  });
});

describe('viewLabel', () => {
  it('says nothing when nobody has looked — an empty chip is worse than no chip', () => {
    expect(viewLabel(summarizeViews([{ viewed_at: ago(1), viewer_kind: 'bot' }]))).toBeNull();
  });

  it('counts the looks', () => {
    const label = viewLabel(summarizeViews([
      { viewed_at: ago(3), viewer_kind: 'human' },
      { viewed_at: ago(1), viewer_kind: 'human' },
    ]), 'en-US');
    expect(label).toMatch(/^Viewed 2×, last /);
  });
});

describe('isReopen', () => {
  it('fires after a quiet spell', () => {
    expect(isReopen(ago(REOPEN_QUIET_DAYS + 1), new Date(NOW).toISOString())).toBe(true);
  });

  it('does not fire on a second look the same afternoon', () => {
    expect(isReopen(ago(0.2), new Date(NOW).toISOString())).toBe(false);
  });

  it('is not a re-open when this is the FIRST look', () => {
    expect(isReopen(null, new Date(NOW).toISOString())).toBe(false);
  });
});

describe('neverOpenedDue', () => {
  const none = summarizeViews([]);

  it('fires once the quote has sat unopened', () => {
    expect(neverOpenedDue(ago(NEVER_OPENED_DAYS + 1), none, null, NOW)).toBe(true);
  });

  it('stays quiet while it is still fresh', () => {
    expect(neverOpenedDue(ago(1), none, null, NOW)).toBe(false);
  });

  it('never fires for a quote someone HAS opened — that is a different problem', () => {
    const seen = summarizeViews([{ viewed_at: ago(4), viewer_kind: 'human' }]);
    expect(neverOpenedDue(ago(10), seen, null, NOW)).toBe(false);
  });

  it('does not repeat', () => {
    expect(neverOpenedDue(ago(10), none, ago(5), NOW)).toBe(false);
  });

  it('has nothing to measure without a send time', () => {
    expect(neverOpenedDue(null, none, null, NOW)).toBe(false);
  });

  it('says nothing about a quote sent before tracking existed — unknown is not "nobody looked"', () => {
    // Sent 10 days ago; we only started watching 5 days ago.
    expect(neverOpenedDue(ago(10), none, null, NOW, ago(5))).toBe(false);
    // Sent after tracking began: now it is a real observation.
    expect(neverOpenedDue(ago(4), none, null, NOW, ago(5))).toBe(true);
  });

  it('withholds the alert entirely when the start marker is missing', () => {
    expect(neverOpenedDue(ago(10), none, null, NOW, null)).toBe(false);
  });

  it('a machine fetch does NOT count as opened — that is exactly the case this alert is for', () => {
    const botsOnly = summarizeViews([{ viewed_at: ago(4), viewer_kind: 'bot' }]);
    expect(neverOpenedDue(ago(10), botsOnly, null, NOW)).toBe(true);
  });
});
