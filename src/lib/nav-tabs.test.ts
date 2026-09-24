import { describe, it, expect } from 'vitest';
import { allTabs, resolveNavTabs, defaultNavTabs, AI_TAB_ID, MAX_TABS } from './nav-tabs';

const ids = (tabs: { id: string }[]) => tabs.map(t => t.id);

describe('defaultNavTabs', () => {
  it('keeps AI in the last slot and fills the rest by priority', () => {
    const tabs = defaultNavTabs(allTabs);
    expect(tabs).toHaveLength(MAX_TABS);
    expect(tabs[MAX_TABS - 1].id).toBe(AI_TAB_ID);
    expect(ids(tabs).slice(0, 3)).toEqual(['home', 'upfit', 'graphics']);
  });

  it('gives the last slot back to a normal tab when AI is not available', () => {
    const tabs = defaultNavTabs(allTabs.filter(t => t.id !== AI_TAB_ID));
    expect(tabs).toHaveLength(MAX_TABS);
    expect(ids(tabs)).not.toContain(AI_TAB_ID);
  });
});

describe('resolveNavTabs', () => {
  it('uses the saved order', () => {
    expect(ids(resolveNavTabs(allTabs, ['estimates', 'ai', 'home']))).toEqual(['estimates', 'ai', 'home']);
  });

  it('drops tabs the user can no longer see, unknown ids and duplicates', () => {
    const available = allTabs.filter(t => t.id !== 'pos');
    expect(ids(resolveNavTabs(available, ['pos', 'home', 'bogus', 'home', 'ai']))).toEqual(['home', 'ai']);
  });

  it('caps a saved list at MAX_TABS', () => {
    expect(resolveNavTabs(allTabs, allTabs.map(t => t.id))).toHaveLength(MAX_TABS);
  });

  it('falls back to the default when nothing saved is usable', () => {
    expect(resolveNavTabs(allTabs, ['bogus'])).toEqual(defaultNavTabs(allTabs));
    expect(resolveNavTabs(allTabs, null)).toEqual(defaultNavTabs(allTabs));
    expect(resolveNavTabs(allTabs, [])).toEqual(defaultNavTabs(allTabs));
  });
});
