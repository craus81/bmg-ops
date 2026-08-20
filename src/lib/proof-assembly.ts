// Planning for the dimensioned-proof export: decide, page by page, how the
// ORIGINAL proof PDF gets rebuilt — which source pages stay as-is, where
// the dimensioned versions go, and which guide pages (image uploads, pages
// from a different PDF) get appended at the end. Pure so it's testable;
// proof-pdf.ts executes the plan with pdf-lib.

import type { GuidePage } from './install-guide';

export type ProofMode = 'replace' | 'insert';

export type AssemblyStep =
  | { kind: 'original'; sourceIndex: number } // 0-based page index in the source PDF
  | { kind: 'dimensioned'; pageId: string };

export interface AssemblyPlan {
  steps: AssemblyStep[];
  /** Guide page ids appended after the source deck (no match in it). */
  appended: string[];
}

/** The stored PDF the export rebuilds: the first source among the guide's
 *  pages, in guide order. Null when nothing was imported from a PDF. */
export function baseSourcePath(pages: GuidePage[]): string | null {
  for (const p of pages) {
    if (p.source_pdf_path && p.source_page) return p.source_pdf_path;
  }
  return null;
}

export function planProofAssembly(
  sourcePageCount: number,
  pages: GuidePage[],
  sourcePdfPath: string,
  mode: ProofMode,
): AssemblyPlan {
  const bySourcePage = new Map<number, GuidePage[]>();
  const appended: string[] = [];
  for (const p of pages) {
    const n = p.source_pdf_path === sourcePdfPath ? p.source_page || 0 : 0;
    if (n >= 1 && n <= sourcePageCount) {
      const list = bySourcePage.get(n) || [];
      list.push(p);
      bySourcePage.set(n, list);
    } else {
      appended.push(p.id);
    }
  }

  const steps: AssemblyStep[] = [];
  for (let n = 1; n <= sourcePageCount; n++) {
    const matches = bySourcePage.get(n) || [];
    if (mode === 'replace' && matches.length > 0) {
      // The dimensioned version stands in for the original.
      for (const m of matches) steps.push({ kind: 'dimensioned', pageId: m.id });
    } else {
      steps.push({ kind: 'original', sourceIndex: n - 1 });
      for (const m of matches) steps.push({ kind: 'dimensioned', pageId: m.id });
    }
  }
  return { steps, appended };
}
