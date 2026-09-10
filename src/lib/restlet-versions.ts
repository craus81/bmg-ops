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
    expectedVersion: '2026-09-10.1',
    powers: 'Writing item descriptions, names and prices back to NetSuite — catalog auto-enrichment and part admin edits',
    runbook: null,
  },
  {
    key: 'pdf' as const,
    label: 'PDF RESTlet',
    envVar: 'NETSUITE_PDF_RESTLET_URL',
    scriptFile: 'scripts/netsuite-pdf-restlet.js',
    expectedVersion: '2026-09-10.1',
    powers: "NetSuite's own transaction PDFs — the invoice and statement copies every customer email is required to carry",
    runbook: null,
  },
] as const;

export type RestletKey = (typeof RESTLET_SPECS)[number]['key'];
