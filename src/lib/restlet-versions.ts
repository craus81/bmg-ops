/**
 * Expected versions of the three hand-deployed NetSuite RESTlets.
 *
 * RESTlets are uploaded to the NetSuite File Cabinet by hand — there is no
 * deploy pipeline — so the code running in NetSuite can lag the repo by an
 * arbitrary amount, and nothing says so. That failure has real history here:
 * the P&L band shipped in #851 and sat dark for days waiting on a re-upload,
 * and `getCustomerPaymentsFromRestlet` still carries a bespoke "needs the
 * updated financials RESTlet" string because an old deployment answers
 * successfully with a missing field.
 *
 * Each script now answers `action=ping` with its own SCRIPT_VERSION. The
 * Integration Checkup compares that against the values below, so "I
 * re-uploaded it" becomes a fact the app can confirm rather than a hope.
 *
 * WHEN YOU EDIT A RESTLET: bump `SCRIPT_VERSION` in the script AND the
 * matching value here. `restlet-versions.test.ts` reads the script files and
 * fails when the two drift — that test is the only thing keeping this honest.
 */

export const RESTLET_SPECS = [
  {
    key: 'financials' as const,
    label: 'Financials RESTlet',
    envVar: 'NETSUITE_FINANCIALS_RESTLET_URL',
    scriptFile: 'scripts/netsuite-financials-restlet.js',
    expectedVersion: '2026-09-10.1',
    /** What stops working when this one is missing or stale. */
    powers: 'Cash / A-P / card / sales-tax tiles, the P&L band (GM%, net profit %, payroll, labor % of revenue, collections), and customer payment history',
    /** Deploy runbook, when one exists. */
    runbook: 'docs/pnl-restlet-deploy.md',
  },
  {
    key: 'item' as const,
    label: 'Item RESTlet',
    envVar: 'NETSUITE_ITEM_RESTLET_URL',
    scriptFile: 'scripts/netsuite-item-restlet.js',
    expectedVersion: '2026-10-23.1',
    powers: 'Writing item descriptions, names and prices back to NetSuite — catalog auto-enrichment and part admin edits — and making drop ship POs from a sales order (Drop ship from vendor on the estimate)',
    runbook: null,
  },
  {
    key: 'pdf' as const,
    label: 'PDF RESTlet',
    envVar: 'NETSUITE_PDF_RESTLET_URL',
    scriptFile: 'scripts/netsuite-pdf-restlet.js',
    expectedVersion: '2026-11-01.1',
    powers: "NetSuite's own transaction PDFs — the invoice and statement copies every customer email is required to carry, and the ledger mirror's credit-memo copies — and attaching FleetSuite's own invoice PDF to NetSuite's invoice once Invoice PDFs is switched on",
    runbook: 'docs/netsuite-ledger-grants.md',
  },
] as const;

export type RestletKey = (typeof RESTLET_SPECS)[number]['key'];

/**
 * The oldest PDF RESTlet each of its later powers works on: rendering a credit
 * memo came in 2026-09-15.1, attaching FleetSuite's own invoice PDF to
 * NetSuite's invoice (Books part 68) in 2026-11-01.1. Each caller gates on its
 * own minimum, not on expectedVersion, so a newer script the owner hasn't
 * uploaded yet never stops what the deployed one can already do.
 */
export const PDF_RESTLET_MINIMUMS = {
  creditMemos: '2026-09-15.1',
  attachPdf: '2026-11-01.1',
} as const;

/**
 * Whether a deployed SCRIPT_VERSION ('YYYY-MM-DD.N') is the minimum or newer:
 * the day as text, then N as a number, so .10 comes after .9. One that isn't
 * in that shape isn't new enough.
 */
export function versionAtLeast(deployed: string | null | undefined, minimum: string): boolean {
  const shape = /^(\d{4}-\d{2}-\d{2})\.(\d+)$/;
  const have = shape.exec(deployed ?? '');
  const need = shape.exec(minimum);
  if (!have || !need) return false;
  if (have[1] !== need[1]) return have[1] > need[1];
  return Number(have[2]) >= Number(need[2]);
}
