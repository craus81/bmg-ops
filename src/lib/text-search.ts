/**
 * The keyword scorer the knowledge search has used since the AI agent
 * shipped, lifted out of the chat route so the in-app Help Center can rank
 * with the SAME rules (R6-13, audit line 431) instead of growing a second
 * one that slowly disagrees with it.
 *
 * Deliberately not a full-text index: it is a small, explainable ranking
 * over a few hundred rows — a title hit beats a body hit, a whole-phrase hit
 * beats scattered words, and a tag hit counts for more than a body mention
 * because someone chose that tag on purpose.
 */

export interface ScorableDoc {
  title?: string | null;
  content?: string | null;
  tags?: (string | null)[] | null;
}

export const SCORE_WEIGHTS = {
  phraseInTitle: 10,
  phraseInContent: 5,
  termInTitle: 3,
  termInTag: 4,
  termInContent: 1,
} as const;

/** Words worth matching on. Anything under three characters is noise. */
export function searchTerms(query: string): string[] {
  return String(query || '')
    .trim()
    .split(/\s+/)
    .filter(t => t.length >= 3);
}

/** 0 means no match at all — callers must drop those rather than show them. */
export function scoreDoc(doc: ScorableDoc, query: string): number {
  const phrase = String(query || '').trim().toLowerCase();
  if (!phrase) return 0;

  const title = String(doc.title || '').toLowerCase();
  const content = String(doc.content || '').toLowerCase();
  const tags = (doc.tags || []).map(t => String(t || '').toLowerCase());

  let score = 0;
  if (title.includes(phrase)) score += SCORE_WEIGHTS.phraseInTitle;
  if (content.includes(phrase)) score += SCORE_WEIGHTS.phraseInContent;

  for (const raw of searchTerms(phrase)) {
    const term = raw.toLowerCase();
    if (title.includes(term)) score += SCORE_WEIGHTS.termInTitle;
    if (tags.some(t => t.includes(term))) score += SCORE_WEIGHTS.termInTag;
    if (content.includes(term)) score += SCORE_WEIGHTS.termInContent;
  }
  return score;
}

/**
 * Rank and drop the non-matches. Ties keep their input order, so a caller
 * that pre-sorted by something meaningful (recency, catalogue order) still
 * gets that order among equally relevant hits instead of an arbitrary one.
 */
export function rankDocs<T extends ScorableDoc>(docs: T[], query: string, limit?: number): (T & { score: number })[] {
  const scored = docs
    .map((doc, i) => ({ doc, i, score: scoreDoc(doc, query) }))
    .filter(x => x.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .map(x => ({ ...x.doc, score: x.score }));
  return limit == null ? scored : scored.slice(0, limit);
}
