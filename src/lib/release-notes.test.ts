import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { FeatureKey } from '@/lib/features';
import {
  ALL_NOTES, RELEASE_AREAS, canSeeArea, groupReleases, isNewer, releaseDayLabel, releaseNumber,
  releaseNotesMarkdown, releaseSummary, releasesFor, type ReleaseNote, type ReleaseViewer,
} from '@/lib/release-notes';

const viewer = (over: Partial<ReleaseViewer> & { features?: FeatureKey[] } = {}): ReleaseViewer => ({
  customer: false, isAdmin: false, books: false,
  hasFeature: f => (over.features || []).includes(f),
  ...over,
});

const note = (date: string, areas: ReleaseNote['areas'], kind: ReleaseNote['kind'] = 'new'): ReleaseNote =>
  ({ date, kind, text: `${date} ${areas.join(',')}`, where: 'Somewhere', areas });

describe('release-notes.json', () => {
  it('every line is complete and in a known area', () => {
    expect(ALL_NOTES.length).toBeGreaterThan(0);
    for (const n of ALL_NOTES) {
      expect(n.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['new', 'fix']).toContain(n.kind);
      expect(n.text.trim().length).toBeGreaterThan(10);
      expect(n.text.trim()).toMatch(/[.!?]$/);
      expect(n.where.trim().length).toBeGreaterThan(0);
      expect(n.areas.length).toBeGreaterThan(0);
      for (const a of n.areas) expect(RELEASE_AREAS).toContain(a);
    }
  });

  it('no line names the AI vendor (the app says FleetSuite AI)', () => {
    for (const n of ALL_NOTES) expect(`${n.text} ${n.where}`).not.toMatch(/\bClaude\b/);
  });
});

describe('releases', () => {
  it('numbers a release by its day', () => {
    expect(releaseNumber('2026-11-06')).toBe('2026.11.06');
  });

  it('groups by day, newest first', () => {
    const r = groupReleases([note('2026-11-04', ['everyone']), note('2026-11-06', ['sales']), note('2026-11-04', ['shop'])]);
    expect(r.map(x => x.number)).toEqual(['2026.11.06', '2026.11.04']);
    expect(r[1].notes).toHaveLength(2);
  });

  it('shows each person only their areas', () => {
    const list = [note('2026-11-06', ['everyone']), note('2026-11-06', ['sales']), note('2026-11-06', ['books']), note('2026-11-05', ['purchasing'])];
    const installer = releasesFor(viewer({ features: ['scan'] }), list);
    expect(installer).toHaveLength(1);
    expect(installer[0].notes.map(n => n.areas[0])).toEqual(['everyone']);

    const sales = releasesFor(viewer({ features: ['estimates'] }), list);
    expect(sales[0].notes).toHaveLength(2);

    const admin = releasesFor(viewer({ isAdmin: true }), list);
    expect(admin.flatMap(r => r.notes).some(n => n.areas.includes('books'))).toBe(false);
    expect(admin).toHaveLength(2);

    const owner = releasesFor(viewer({ isAdmin: true, books: true }), list);
    expect(owner.flatMap(r => r.notes)).toHaveLength(4);
  });

  it('customers see nothing', () => {
    expect(canSeeArea('everyone', viewer({ customer: true }))).toBe(false);
  });

  it('compares release numbers', () => {
    expect(isNewer('2026.11.06', null)).toBe(true);
    expect(isNewer('2026.11.06', '2026.11.05')).toBe(true);
    expect(isNewer('2026.11.06', '2026.11.06')).toBe(false);
    expect(isNewer(undefined, null)).toBe(false);
  });

  it('sums up a release', () => {
    const r = groupReleases([note('2026-11-06', ['everyone']), note('2026-11-06', ['everyone']), note('2026-11-06', ['everyone'], 'fix')])[0];
    expect(releaseSummary(r)).toBe('2 new things and 1 fix');
  });

  it('labels the day without a time zone slip', () => {
    expect(releaseDayLabel('2026-11-06')).toBe('Friday, Nov 6');
  });
});

describe('docs/help/whats-new.md', () => {
  it('matches release-notes.json', () => {
    const path = resolve(__dirname, '../../docs/help/whats-new.md');
    const want = releaseNotesMarkdown();
    if (process.env.UPDATE_WHATS_NEW) writeFileSync(path, want);
    const have = existsSync(path) ? readFileSync(path, 'utf8') : '';
    expect(have, 'Run: UPDATE_WHATS_NEW=1 npx vitest run src/lib/release-notes.test.ts').toBe(want);
  });
});
