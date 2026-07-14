/**
 * Filename-based classification of PO email attachments, shared by the email
 * importer, the Gmail attachment viewer, and the PO PDF backfill so they all
 * agree on what counts as a proof.
 *
 * A "proof-like" file is a graphics proof / artwork rendering — never the PO
 * document — unless the name itself also claims to be a PO. Client-safe.
 */
export function isProofLikeName(name: string): boolean {
  return /proof|artwork|graphics?|mock.?up|rendering/i.test(name)
    && !/\b(po|purchase.?order)\b/i.test(name);
}
