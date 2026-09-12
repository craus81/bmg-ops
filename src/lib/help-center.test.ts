import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  GUIDE_ROLES, PAGE_GUIDES, guideForPath, guidesForRoles, partitionForRoles,
  searchGuides, snippetFor, sectionsOf, stripFrontmatter,
  type HelpDoc,
} from './help-center';
import { ROLE_DEFAULT_FEATURES } from './features';

const doc = (slug: string, over: Partial<HelpDoc> = {}): HelpDoc => ({
  id: slug, slug, title: slug, tags: ['help', slug], content: '', ...over,
});

describe('the catalogue matches what is actually in the repo', () => {
  const helpDir = join(process.cwd(), 'docs', 'help');

  it('every page → guide mapping points at a markdown file that exists', () => {
    // The whole point of the "?" affordance is that it opens something. A
    // renamed or deleted guide has to fail here, not in a user's face.
    for (const { prefix, slug } of PAGE_GUIDES) {
      expect(existsSync(join(helpDir, `${slug}.md`)), `${prefix} → docs/help/${slug}.md`).toBe(true);
    }
  });

  it('every role-tagged guide exists and names real roles', () => {
    const realRoles = new Set(Object.keys(ROLE_DEFAULT_FEATURES));
    for (const [slug, roles] of Object.entries(GUIDE_ROLES)) {
      expect(existsSync(join(helpDir, `${slug}.md`)), `docs/help/${slug}.md`).toBe(true);
      for (const r of roles) expect(realRoles.has(r), `role '${r}' on guide '${slug}'`).toBe(true);
    }
  });

  it('is not vacuously passing on an empty catalogue', () => {
    expect(PAGE_GUIDES.length).toBeGreaterThan(8);
    expect(Object.keys(GUIDE_ROLES).length).toBeGreaterThan(4);
  });
});

describe('guideForPath', () => {
  it('takes the longest matching prefix', () => {
    expect(guideForPath('/admin/prospects/abc')).toBe('sales');
    expect(guideForPath('/admin/system-health')).toBe('admin');
    expect(guideForPath('/graphics/123')).toBe('graphics-production');
  });

  it('matches a prefix only at a path boundary', () => {
    // /admin must not claim /administration.
    expect(guideForPath('/administration')).toBeNull();
    expect(guideForPath('/admin')).toBe('admin');
  });

  it('returns null for a screen no guide covers, so no "?" renders', () => {
    expect(guideForPath('/upfit-designer')).toBeNull();
    expect(guideForPath('/settings')).toBeNull();
    expect(guideForPath('')).toBeNull();
    expect(guideForPath(null)).toBeNull();
  });

  it('ignores a query string and hash', () => {
    expect(guideForPath('/estimates?id=1#x')).toBe('sales');
  });
});

describe('role filtering orders, it never hides', () => {
  const docs = [doc('getting-started'), doc('sales'), doc('installer'), doc('admin'), doc('glossary')];

  it('puts your guides first and keeps every other one readable', () => {
    const { mine, others } = partitionForRoles(docs, ['sales']);
    expect(mine.map(d => d.slug)).toEqual(['sales']);
    // Nothing is dropped — the two lists together are the whole library.
    expect([...mine, ...others]).toHaveLength(docs.length);
    expect(others.map(d => d.slug)).toContain('installer');
  });

  it('gives an admin both admin aliases', () => {
    expect(guidesForRoles(docs, ['super_admin']).map(d => d.slug)).toEqual(['admin']);
    expect(guidesForRoles(docs, ['admin']).map(d => d.slug)).toEqual(['admin']);
  });

  it('a role with no guide of its own still sees the whole library', () => {
    const { mine, others } = partitionForRoles(docs, ['finance']);
    expect(mine).toEqual([]);
    expect(others).toHaveLength(docs.length);
  });
});

describe('search', () => {
  const docs = [
    doc('sales', { title: 'Sales guide', content: 'How to send an estimate for approval.' }),
    doc('installer', { title: 'Installer guide', content: 'Upload completion photos after every install.' }),
  ];

  it('ranks a title hit above a body hit', () => {
    const hits = searchGuides(docs, 'installer');
    expect(hits[0].slug).toBe('installer');
  });

  it('returns nothing for an empty query rather than the whole library', () => {
    expect(searchGuides(docs, '')).toEqual([]);
    expect(searchGuides(docs, '   ')).toEqual([]);
  });

  it('drops guides that do not match at all', () => {
    expect(searchGuides(docs, 'zzzznothing')).toEqual([]);
  });
});

describe('snippetFor', () => {
  const d = doc('sales', { content: '# Sales guide\n\nSend the estimate for approval.\nChase it after five days.' });

  it('quotes the line that actually matched', () => {
    expect(snippetFor(d, 'approval')).toBe('Send the estimate for approval.');
    expect(snippetFor(d, 'chase')).toBe('Chase it after five days.');
  });

  it('returns null rather than the opening paragraph when nothing matched', () => {
    // A snippet that doesn't contain the term reads as a match that isn't one.
    expect(snippetFor(d, 'payroll')).toBeNull();
    expect(snippetFor(d, '')).toBeNull();
  });

  it('never quotes a heading as the answer', () => {
    expect(snippetFor(d, 'sales guide')).toBeNull();
  });
});

describe('sectionsOf', () => {
  it('lists headings with unique anchors', () => {
    const s = sectionsOf('# One\ntext\n## Two\n### Three');
    expect(s).toEqual([
      { id: 'one', heading: 'One', level: 1 },
      { id: 'two', heading: 'Two', level: 2 },
      { id: 'three', heading: 'Three', level: 3 },
    ]);
  });

  it('disambiguates repeated headings so a deep link can not land on the wrong one', () => {
    expect(sectionsOf('## Notes\n## Notes\n## Notes').map(s => s.id)).toEqual(['notes', 'notes-2', 'notes-3']);
  });

  it('ignores a # inside a fenced code block', () => {
    expect(sectionsOf('# Real\n```\n# not a heading\n```\n## Also real').map(s => s.heading))
      .toEqual(['Real', 'Also real']);
  });
});

describe('stripFrontmatter', () => {
  it('removes YAML frontmatter and leaves plain markdown alone', () => {
    expect(stripFrontmatter('---\ntags: a, b\n---\n# Title')).toBe('# Title');
    expect(stripFrontmatter('# Title')).toBe('# Title');
    expect(stripFrontmatter('---\nunterminated')).toBe('---\nunterminated');
  });
});
