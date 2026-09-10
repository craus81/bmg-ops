import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  ENV_SPECS, ENV_GROUPS, checkEnv, countIds, classifyRestlet, compareMigrations, rollUp,
  type EnvSpec,
} from './integration-checkup';
import { RESTLET_SPECS } from './restlet-versions';

/**
 * Strip comments before scanning for env references — prose about
 * `process.env.SOMETHING` is documentation, not usage, and counting it would
 * make this guard fail on a docstring. The `[^:]` guard keeps `https://`
 * from eating the rest of a line.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const spec = (over: Partial<EnvSpec> = {}): EnvSpec =>
  ({ name: 'X_VAR', group: 'platform', powers: 'a thing', whenMissing: 'warn', ...over });

const restlet = {
  label: 'Financials RESTlet',
  envVar: 'NETSUITE_FINANCIALS_RESTLET_URL',
  expectedVersion: '2026-09-10.1',
  powers: 'the P&L band',
  runbook: 'docs/pnl-restlet-deploy.md',
};

describe('checkEnv', () => {
  it('reports presence without ever echoing the value', () => {
    const row = checkEnv(spec({ name: 'SECRET_KEY' }), 'hunter2-super-secret');
    expect(row.status).toBe('ok');
    expect(JSON.stringify(row)).not.toContain('hunter2');
  });

  it('treats whitespace as absent', () => {
    expect(checkEnv(spec(), '   ').status).toBe('warn');
  });

  it('escalates a missing core variable to fail, a feature variable to warn', () => {
    expect(checkEnv(spec({ whenMissing: 'fail' }), undefined).status).toBe('fail');
    expect(checkEnv(spec({ whenMissing: 'warn' }), undefined).status).toBe('warn');
  });

  it('does not scold about a genuinely optional variable', () => {
    const row = checkEnv(spec({ whenMissing: 'off' }), undefined);
    expect(row.status).toBe('unknown');
    expect(row.fix).toBeUndefined();
  });

  it('counts ids in a list without naming them', () => {
    const row = checkEnv(spec({ idList: true }), '101, 102 ,103');
    expect(row.detail).toBe('Set — 3 account ids');
    expect(row.detail).not.toContain('101');
  });

  it('singularizes a one-id list', () => {
    expect(checkEnv(spec({ idList: true }), '101').detail).toBe('Set — 1 account id');
  });
});

describe('countIds', () => {
  it('ignores blanks and stray separators', () => {
    expect(countIds('1,,2, ,3,')).toBe(3);
    expect(countIds('')).toBe(0);
  });
});

describe('classifyRestlet', () => {
  it('fails when no URL is configured', () => {
    expect(classifyRestlet(restlet, false, null).status).toBe('fail');
  });

  it('fails when the URL does not answer', () => {
    const row = classifyRestlet(restlet, true, { reachable: false, error: 'timeout' });
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('timeout');
  });

  // The regression this whole feature exists for: an old deployment answers
  // 200 and looks deployed. Reachable-but-versionless must NOT read as OK.
  it('fails a reachable RESTlet that cannot report a version', () => {
    const row = classifyRestlet(restlet, true, { reachable: true, version: null });
    expect(row.status).toBe('fail');
    expect(row.fix).toContain('Re-upload');
  });

  it('warns on a version mismatch and names both sides', () => {
    const row = classifyRestlet(restlet, true, { reachable: true, version: '2026-01-01.1' });
    expect(row.status).toBe('warn');
    expect(row.detail).toContain('2026-01-01.1');
    expect(row.detail).toContain('2026-09-10.1');
  });

  it('passes only on an exact match', () => {
    const row = classifyRestlet(restlet, true, { reachable: true, version: '2026-09-10.1' });
    expect(row.status).toBe('ok');
    expect(row.fix).toBeUndefined();
  });
});

describe('compareMigrations', () => {
  it('fails when the repo ships a migration the database has not applied', () => {
    const row = compareMigrations(['001-a.sql', '002-b.sql'], ['001-a.sql']);
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('002-b.sql');
  });

  it('caps the pending list and says how many more there are', () => {
    const repo = Array.from({ length: 9 }, (_, i) => `${String(i).padStart(3, '0')}-m.sql`);
    const row = compareMigrations(repo, []);
    expect(row.detail).toContain('+4 more');
  });

  it('passes when everything is applied', () => {
    expect(compareMigrations(['001-a.sql'], ['001-a.sql']).status).toBe('ok');
  });

  it('notes applied rows the repo no longer has, without failing on them', () => {
    const row = compareMigrations(['001-a.sql'], ['001-a.sql', '000-renamed.sql']);
    expect(row.status).toBe('ok');
    expect(row.detail).toContain('1 applied row');
  });

  // Bundling can fail without anything else breaking. An unreadable repo
  // list must never be reported as "all applied" against nothing.
  it('reports unknown rather than green when the repo list is unreadable', () => {
    const row = compareMigrations([], ['001-a.sql']);
    expect(row.status).toBe('unknown');
  });
});

describe('rollUp', () => {
  const row = (status: any) => ({ key: 'k', label: 'l', status, detail: 'd' });

  it('lets the worst status win', () => {
    expect(rollUp([row('ok'), row('warn'), row('fail')])).toBe('fail');
    expect(rollUp([row('ok'), row('warn')])).toBe('warn');
    expect(rollUp([row('ok'), row('unknown')])).toBe('ok');
    expect(rollUp([row('unknown')])).toBe('unknown');
    expect(rollUp([])).toBe('unknown');
  });
});

describe('the catalog itself', () => {
  it('puts every spec in a real group', () => {
    const known = new Set(ENV_GROUPS.map(g => g.key));
    for (const s of ENV_SPECS) expect(known, `${s.name} → ${s.group}`).toContain(s.group);
  });

  it('has no duplicate entries', () => {
    const names = ENV_SPECS.map(s => s.name);
    expect(names.length).toBe(new Set(names).size);
  });

  /**
   * The rot guard. A checkup that quietly stops covering new integrations is
   * worse than no checkup, because it reports "all good" about a surface it
   * no longer looks at. Adding `process.env.NEW_THING` to src/ fails this
   * test until NEW_THING is catalogued with what it powers.
   */
  it('covers every process.env variable the source actually reads', () => {
    const srcRoot = join(__dirname, '..');
    const used = new Set<string>();

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        // Tests set fixture env vars that aren't real configuration.
        if (/\.test\.tsx?$/.test(entry)) continue;
        const code = stripComments(readFileSync(full, 'utf8'));
        for (const m of code.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
          used.add(m[1]);
        }
      }
    };
    walk(srcRoot);

    // The RESTlet URLs are catalogued in RESTLET_SPECS instead, where they
    // carry a script path and expected version as well as a name.
    const catalogued = new Set([
      ...ENV_SPECS.map(s => s.name),
      ...RESTLET_SPECS.map(s => s.envVar),
    ]);
    const missing = [...used].filter(n => !catalogued.has(n)).sort();
    expect(missing, `uncatalogued env vars — add them to ENV_SPECS with what they power: ${missing.join(', ')}`).toEqual([]);
  });
});
