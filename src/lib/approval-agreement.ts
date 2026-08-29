/**
 * The E-SIGN agreement sentence a customer checks to accept a quote or
 * estimate — ONE copy for every surface. The public approval pages render
 * it and send it with the accept POST (via ApprovalPageShell), and the
 * approval routes stamp it into the frozen signed snapshot (falling back
 * to it when the client omits the text). Kept in its own client-safe
 * module because src/lib/magic-link-approval.ts (which re-exports it for
 * the routes) pulls in crypto/R2 that the browser can't load.
 *
 * The proof flow deliberately uses different wording ("approve this
 * graphic proof … produce and install it as shown") — that copy lives on
 * its page, passed through the shell's agreementText prop.
 */
export const AGREEMENT_TEXT =
  'By checking this box, I agree to the terms of this document and authorize BMG Fleet Installations to begin work. ' +
  'This action is legally binding and equivalent to a signed agreement under the U.S. E-SIGN Act.';

/**
 * The combined design + price sentence, used when an estimate's approval
 * send includes graphic proofs from linked graphics jobs
 * (graphics_jobs.estimate_attach): one checkbox approves the artwork for
 * production AND authorizes the quoted work, and the approval route
 * propagates the acceptance onto those jobs.
 */
export const COMBINED_AGREEMENT_TEXT =
  'By checking this box, I approve the graphic proof(s) shown for production as-is, agree to the terms of this document, ' +
  'and authorize BMG Fleet Installations to begin work. ' +
  'This action is legally binding and equivalent to a signed agreement under the U.S. E-SIGN Act.';
