import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Every screen that renders currency must either consult the money gate or be
 * declared here with the reason it doesn't have to.
 *
 * WHY THIS EXISTS. The money rule (src/lib/money-visibility.ts) was rolled out
 * by grepping for dollar signs, and the grep missed the home dashboard —
 * because /home renders <OpsDashboard/> and the money lives in the component,
 * not the page. The owner found it by using "View As" and screenshotting
 * $228,464 of invoiced revenue while viewing as graphics production. A one-off
 * sweep is exactly the thing that rots; this is the sweep, kept.
 *
 * An entry in ALLOWED is not "this is fine" — it is "this file renders money
 * on purpose, and here is what stops the shop floor reaching it." Adding a
 * currency-rendering file means choosing: gate it, or say why not.
 */

const MONEY = /style:\s*'currency'|\$\$\{|formatCurrency|fmtMoney|fmtUsd|fmtK\(/;
const GATED = /canSeeMoney|showMoney|showPrice|showCost/;

/**
 * Files that render money without the gate, each with what walls them off.
 * Keyed by path; the value is the reason, which must not be empty.
 */
const ALLOWED: Record<string, string> = {
  // ── Walled by a feature only money roles hold ──
  'src/app/(main)/admin/ap/page.tsx': 'vendor_payments — finance/admin only',
  'src/app/(main)/admin/credit-applications/page.tsx': 'credit_applications — finance/admin/sales',
  'src/app/(main)/admin/payroll/page.tsx': 'payroll — admin only',
  'src/app/(main)/admin/parts-mail/page.tsx': 'part_admin — admin only',
  'src/app/(main)/admin/scans/page.tsx': 'admin console',
  'src/app/(main)/admin/import-installs/page.tsx': 'data_import — admin only',
  'src/app/(main)/admin/wrap-quote/page.tsx': 'the wrap quote builder — sales/admin',
  'src/app/(main)/admin/prospects/page.tsx': 'prospects — sales/admin',
  'src/app/(main)/admin/prospects/[id]/page.tsx': 'prospects — sales/admin',
  'src/app/(main)/estimates/page.tsx': 'estimates — sales/admin since the money rule removed it from graphics_production',
  'src/app/(main)/quotes/page.tsx': 'the customer-facing quote view, reached by token',
  'src/app/(main)/upfit-designer/page.tsx': 'upfit_configurator — sales/admin',
  'src/components/AddToEstimateModal.tsx': 'opens only from the estimate builder',
  'src/components/PartCatalogBrowser.tsx': 'used by the estimate builder and part_admin, both money-walled',
  'src/components/GraphicsInvoiceReviewModal.tsx': 'rendered only behind canSeeMoney on the graphics board and record',
  'src/components/FinancialsDashboard.tsx': 'financials — super_admin/executive only',

  // ── CNI admin console ──
  'src/app/(main)/admin/cni/jobs/[id]/page.tsx': 'cni_admin — admin only',
  'src/app/(main)/admin/cni/jobs/[id]/shifts/page.tsx': 'cni_admin — admin only',
  'src/app/(main)/admin/cni/payouts/page.tsx': 'cni_admin — admin only',

  // ── Reports: every one is behind the reports feature (admin/finance/exec) ──
  'src/app/(main)/admin/reports/accounting-package/page.tsx': 'reports',
  'src/app/(main)/admin/reports/at-risk/page.tsx': 'reports',
  'src/app/(main)/admin/reports/cash-outlook/page.tsx': 'reports',
  'src/app/(main)/admin/reports/graphics-costs/page.tsx': 'reports; its API is requireMoney',
  'src/app/(main)/admin/reports/installer-costs/page.tsx': 'reports',
  'src/app/(main)/admin/reports/invoice-reconciliation/page.tsx': 'reports',
  'src/app/(main)/admin/reports/material-yield/page.tsx': 'reports',
  'src/app/(main)/admin/reports/never-invoiced/page.tsx': 'reports',
  'src/app/(main)/admin/reports/order-book/page.tsx': 'reports',
  'src/app/(main)/admin/reports/quoted-margin/page.tsx': 'reports',
  'src/app/(main)/admin/reports/sales-by-customer-detail/page.tsx': 'reports',
  'src/app/(main)/admin/reports/sales-performance/page.tsx': 'reports',
  'src/app/(main)/admin/reports/vehicle-margin/page.tsx': 'reports',
  'src/app/(main)/admin/reports/vendors/page.tsx': 'reports',

  // ── Outside the staff money rule entirely ──
  'src/app/(main)/customer/dashboard/page.tsx': "a customer's own account — their own invoices",
  'src/components/EstimateApprovalDocument.tsx': 'what the customer is shown to approve',
  'src/app/(main)/installer/invoices/page.tsx': "an installer's OWN pay — explicitly kept visible",
  'src/app/(main)/installer/jobs/[id]/page.tsx': "an installer's OWN job pay — explicitly kept visible",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const currencyFiles = [...walk('src/components'), ...walk('src/app/(main)')]
  .filter(f => MONEY.test(readFileSync(f, 'utf8')))
  .sort();

describe('money surfaces', () => {
  it('finds currency rendering to check (the scan itself works)', () => {
    // If this drops to nothing, the pattern stopped matching and every
    // assertion below became vacuously true.
    expect(currencyFiles.length).toBeGreaterThan(20);
  });

  it('gates every currency screen, or declares why it need not be', () => {
    const undeclared = currencyFiles.filter(f =>
      !GATED.test(readFileSync(f, 'utf8')) && !(f in ALLOWED));
    expect(
      undeclared,
      `These render money but neither consult the money gate nor appear in ALLOWED.\n`
      + `Gate them with canSeeMoney, or add an entry saying what walls them off:\n  `
      + undeclared.join('\n  '),
    ).toEqual([]);
  });

  it('keeps the allowlist honest — no stale entries, no blank reasons', () => {
    const stale = Object.keys(ALLOWED).filter(f => !currencyFiles.includes(f));
    expect(stale, `no longer render money (or moved) — drop them: ${stale.join(', ')}`).toEqual([]);
    const unexplained = Object.entries(ALLOWED).filter(([, why]) => !why.trim());
    expect(unexplained.map(([f]) => f), 'every entry needs a reason').toEqual([]);
  });

  it('holds the line on the screens the shop floor actually opens', () => {
    // The regression this test was born from: each of these is reachable by
    // graphics production or a tech, and each leaked money before the fix.
    for (const f of [
      'src/components/OpsDashboard.tsx',
      'src/components/GraphicsMaterialsCard.tsx',
      'src/components/RollNesting.tsx',
      'src/components/GraphicsRollPlan.tsx',
      'src/components/UniversalSearch.tsx',
      'src/components/Popout.tsx',
      'src/components/VehicleCheckIn.tsx',
      'src/app/(main)/parts/page.tsx',
    ]) {
      expect(GATED.test(readFileSync(f, 'utf8')), `${f} must consult the money gate`).toBe(true);
    }
  });
});
