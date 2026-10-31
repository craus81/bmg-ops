import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve, dirname } from 'path';

/**
 * Next won't build a page when code the browser loads imports next/headers or
 * server-only at the top of a file: "You're importing a component that needs
 * next/headers. That only works in a Server Component but one of its parents
 * is marked with "use client"". Code the browser loads is every file a
 * 'use client' file reaches through its imports, dynamic ones included, and
 * that reaches further than it looks: a few phone pages load the NetSuite
 * client through the sales order and pick list helpers. So a server-only
 * import a page reaches is found here, before a build fails on it.
 */

const repoRoot = join(__dirname, '..', '..');
const SERVER_ONLY = new Set(['next/headers', 'server-only']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? join(repoRoot, 'src', spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const file of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

/** A file's imports: at the top of the file (not types only), and dynamic ones anywhere in it. */
function importsOf(text: string): { top: string[]; dynamic: string[] } {
  const top = [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const dynamic = [...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  return { top, dynamic };
}

const files = sources(join(repoRoot, 'src'));
const texts = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
const clients = files.filter((f) => /^\s*['"]use client['"]/.test(texts.get(f)!));

/** Every file the browser loads, with the way one of the 'use client' files reaches it. */
function browserFiles(): Map<string, string[]> {
  const reached = new Map<string, string[]>(clients.map((c) => [c, [c]]));
  const queue = [...clients];
  while (queue.length) {
    const file = queue.shift()!;
    const { top, dynamic } = importsOf(texts.get(file) ?? readFileSync(file, 'utf8'));
    for (const spec of [...top, ...dynamic]) {
      const next = resolveImport(file, spec);
      if (!next || reached.has(next) || !texts.has(next)) continue;
      reached.set(next, [...reached.get(file)!, next]);
      queue.push(next);
    }
  }
  return reached;
}

describe('code the browser loads', () => {
  const reached = browserFiles();

  it('is walked from every page and component marked for the browser', () => {
    // A walker that stopped finding files would make the check below pass vacuously.
    expect(clients.length).toBeGreaterThan(300);
    expect(reached.size).toBeGreaterThan(clients.length);
  });

  it("imports nothing at the top that only works on the server", () => {
    const bad = [...reached].flatMap(([file, trail]) => importsOf(texts.get(file)!).top
      .filter((spec) => SERVER_ONLY.has(spec))
      .map((spec) => `${spec} in ${trail.map((f) => relative(repoRoot, f).replace(/\\/g, '/')).join(' -> ')}`));
    expect(bad, "load it inside the function that needs it instead, as src/lib/netsuite-sends.ts's whoSent does").toEqual([]);
  });

  it('still finds a top-level next/headers import', () => {
    expect(importsOf("import { cookies } from 'next/headers';\nconst x = 1;").top).toEqual(['next/headers']);
    expect(importsOf("import {\n  cookies,\n  headers,\n} from 'next/headers';").top).toEqual(['next/headers']);
    expect(importsOf("import 'server-only';").top).toEqual(['server-only']);
    expect(importsOf("import type { cookies } from 'next/headers';").top).toEqual([]);
    expect(importsOf("const h = await import('next/headers');")).toEqual({ top: [], dynamic: ['next/headers'] });
  });
});
