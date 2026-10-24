import { describe, expect, it } from 'vitest';
import {
  builderUrlFor, clientFileFromBuilderLink, DEFAULT_PANES, MIN_SPLIT_WIDTH, otherPane, paneAt, parseSplitState,
  safePaneUrl, splitAvailable, splitDirection, splitOn,
} from './split-screen';

describe('splitOn', () => {
  it('comes on by itself when the Duo opens, unless turned off', () => {
    expect(splitOn(true, 900, null)).toBe(true);
    expect(splitOn(true, 900, 'on')).toBe(true);
    expect(splitOn(true, 900, 'off')).toBe(false);
  });
  it('stays off on a big computer screen until asked for', () => {
    expect(splitOn(false, 1400, null)).toBe(false);
    expect(splitOn(false, 1400, 'on')).toBe(true);
  });
  it('never splits a phone or the folded Duo, even if it was on', () => {
    expect(splitOn(false, 420, 'on')).toBe(false);
    expect(splitOn(false, MIN_SPLIT_WIDTH - 1, 'on')).toBe(false);
  });
  it('offers the Split button only where it can split', () => {
    expect(splitAvailable(true, 800)).toBe(true);
    expect(splitAvailable(false, MIN_SPLIT_WIDTH)).toBe(true);
    expect(splitAvailable(false, 600)).toBe(false);
  });
});

describe('splitDirection', () => {
  it('puts the panes side by side when the crease runs up and down', () => {
    expect(splitDirection(1180, 840)).toBe('columns');
  });
  it('stacks them when the phone is turned and the crease runs across', () => {
    expect(splitDirection(840, 1180)).toBe('rows');
  });
});

describe('parseSplitState', () => {
  it('starts with Graphics Builder and Client Files', () => {
    expect(parseSplitState(null)).toEqual({ choice: null, urls: DEFAULT_PANES, active: 'a' });
    expect(parseSplitState('not json').urls).toEqual(DEFAULT_PANES);
  });
  it('keeps saved pages and choice', () => {
    const s = parseSplitState(JSON.stringify({ choice: 'off', urls: { a: '/estimates', b: '/graphics?id=5' }, active: 'b' }));
    expect(s).toEqual({ choice: 'off', urls: { a: '/estimates', b: '/graphics?id=5' }, active: 'b' });
  });
  it('drops anything that is not an app page', () => {
    const s = parseSplitState(JSON.stringify({ urls: { a: 'https://evil.example', b: '/api/client-files/1' }, active: 'x' }));
    expect(s.urls).toEqual(DEFAULT_PANES);
    expect(s.active).toBe('a');
  });
});

describe('safePaneUrl', () => {
  it('allows app pages only', () => {
    expect(safePaneUrl('/client-files?client=3')).toBe('/client-files?client=3');
    expect(safePaneUrl('//evil.example/x')).toBeNull();
    expect(safePaneUrl('/login')).toBeNull();
    expect(safePaneUrl('/api/x')).toBeNull();
    expect(safePaneUrl('javascript:alert(1)')).toBeNull();
    expect(safePaneUrl(5)).toBeNull();
  });
});

describe('paneAt', () => {
  const rects = {
    a: { left: 0, top: 0, width: 500, height: 700 },
    b: { left: 512, top: 0, width: 500, height: 700 },
  };
  it('finds the pane under a point, and none on the divider', () => {
    expect(paneAt(100, 100, rects)).toBe('a');
    expect(paneAt(700, 100, rects)).toBe('b');
    expect(paneAt(505, 100, rects)).toBeNull();
    expect(paneAt(700, 900, rects)).toBeNull();
  });
  it('flips sides', () => {
    expect(otherPane('a')).toBe('b');
    expect(otherPane('b')).toBe('a');
  });
});

describe('Graphics Builder links', () => {
  const origin = 'https://go.bmgfleet.com';
  it('reads the file id off a 🎨 Builder link', () => {
    expect(clientFileFromBuilderLink(builderUrlFor('abc-123'), origin)).toBe('abc-123');
    expect(clientFileFromBuilderLink(`${origin}/admin/wrap-quote?clientFile=x9`, origin)).toBe('x9');
  });
  it('ignores other links', () => {
    expect(clientFileFromBuilderLink('/admin/wrap-quote', origin)).toBeNull();
    expect(clientFileFromBuilderLink('/client-files?clientFile=1', origin)).toBeNull();
    expect(clientFileFromBuilderLink('https://other.example/admin/wrap-quote?clientFile=1', origin)).toBeNull();
  });
});
