/**
 * How FleetSuite's books work, written down (Books part 88, migration 510,
 * docs/books.md "How the books work"; the NetSuite Exit Checklist's "How the
 * books work, written down", thread "Replacing NetSuite with FleetSuite",
 * building every piece since 2026-10-31).
 *
 * What posts what, who can change what, what the database won't let anyone
 * do, how backups work and which jobs run by themselves, in words a CPA can
 * read and sign off, for Books → How the books work and its PDF. The IRS
 * covers records kept in software in Rev. Proc. 98-25, which asks for such
 * a description (IRS_RECORDS below).
 *
 * Written next to the code that does the work so it can't drift from it
 * unseen (how-it-works.test.ts): every posting rule the code has is here and
 * nothing else is, a rule's version moving on fails until its words are
 * looked at again, each step's guard is the one its route carries, each
 * refusal's words are the database's own, and the jobs are vercel.json's.
 * The page adds what the books hold today (how-it-works-data.ts): how much
 * each rule has posted, who holds each step now, the switches, the last
 * backup and restore drill, and the CPA's last review.
 *
 * Pure and client-safe: the page imports its types, the loader and the PDF
 * its words.
 */

import { FEATURES, type FeatureKey } from '@/lib/features';
import type { RouteGuardKind } from '@/lib/route-permissions';
import { ROLE_LABELS, type AppRole } from '@/lib/types';
import type { BooksAccess } from './access';
import type { SwitchPiece } from './switches';

// ── What posts what ──────────────────────────────────────────────────────

/** Where a rule's entries come from: NetSuite's documents, FleetSuite's own copies, or going live. */
export type RuleGroup = 'netsuite' | 'own' | 'opening';

export interface PostingRuleInfo {
  /** As the journal keeps it on each entry it posted (gl_entries.posting_rule): name@version. */
  id: string;
  name: string;
  group: RuleGroup;
  /** What it posts, a sentence. */
  from: string;
  /** Its debits and credits, a sentence each. */
  posts: readonly string[];
  note?: string;
  /** The file it's worked out in. */
  code: string;
  /** Its section in docs/books.md. */
  docs: string;
}

export const RULE_GROUPS: Readonly<Record<RuleGroup, { name: string; about: string }>> = {
  netsuite: {
    name: "From NetSuite's documents",
    about: "Through 2027 documents are made in NetSuite, many of them by FleetSuite. Every two hours FleetSuite copies NetSuite's documents and its general ledger, posts each document to its own journal by these rules, and checks each company's months against NetSuite's own totals (Books → Differences). During 2027 the rules take NetSuite's own account choices, so the two books agree line for line.",
  },
  own: {
    name: "From FleetSuite's own copies",
    about: "When FleetSuite makes a document in NetSuite it keeps its own copy, worked out by its own rules rather than read back. The posting run posts from FleetSuite's copy only when it matches NetSuite's document and makes the same entry, account by account, on the same day; otherwise NetSuite's document posts, by its rule above, and the Own pages say why.",
  },
  opening: {
    name: 'Going live',
    about: "Once, when a company's books go live (a super admin's tap on Books → Going live, which can't be undone).",
  },
};

export const POSTING_RULES: readonly PostingRuleInfo[] = [
  {
    id: 'invoice@1', name: 'Invoices', group: 'netsuite',
    from: "Each invoice in the copy of NetSuite's invoices, BMG's and 1084's.",
    posts: [
      "Debit accounts receivable with the invoice's total, for its customer.",
      "Credit each line to its item's income account, as NetSuite's item has it; an item with none goes where NetSuite has posted its invoice lines since 2025.",
      "Credit the sales tax to the account the invoice's tax code has posted to since 2025.",
    ],
    note: "An invoice's stock cost lines, when it wasn't fulfilled first, are the stock rule's.",
    code: 'src/lib/books/invoice-rule.ts', docs: 'Invoices',
  },
  {
    id: 'credit_memo@1', name: 'Credit memos', group: 'netsuite',
    from: "Each credit memo in the copy of NetSuite's credit memos.",
    posts: [
      'The invoice rule the other way round: debit each line to its income account and the sales tax to its account, and credit accounts receivable for the customer.',
    ],
    code: 'src/lib/books/invoice-rule.ts', docs: 'Credit memos',
  },
  {
    id: 'payment@1', name: 'Customer payments', group: 'netsuite',
    from: 'Each customer payment NetSuite has.',
    posts: [
      'Debit the account the money went to, Undeposited Funds or a bank account, as NetSuite posted it.',
      'Debit a discount the customer took to its own account.',
      'Credit accounts receivable with the money and the discount, for the customer.',
    ],
    code: 'src/lib/books/payment-rule.ts', docs: 'Payments',
  },
  {
    id: 'deposit@1', name: 'Customer deposits', group: 'netsuite',
    from: 'Each customer deposit, money paid ahead of an invoice, and each deposit application NetSuite has.',
    posts: [
      'A deposit: debit the account the money went to, as NetSuite posted it, and credit Customer Deposits for the customer.',
      'An application: debit Customer Deposits and credit accounts receivable, so the invoice is paid by money already in hand.',
    ],
    code: 'src/lib/books/deposit-rule.ts', docs: 'Customer deposits',
  },
  {
    id: 'bill@1', name: 'Vendor bills', group: 'netsuite',
    from: 'Each vendor bill and bill credit NetSuite has.',
    posts: [
      "Credit accounts payable with the bill's total, for its vendor.",
      'Debit an expense line to its own account.',
      "Debit a stock item to the account NetSuite holds received stock against until it's billed when the line came from a purchase order, and otherwise to the item's inventory asset account.",
      'Debit any other item to its expense account.',
      'A bill credit posts the same way, the other way round.',
    ],
    code: 'src/lib/books/bill-rule.ts', docs: 'Vendor bills',
  },
  {
    id: 'bill_payment@1', name: 'Bill payments', group: 'netsuite',
    from: 'Each bill payment NetSuite has.',
    posts: [
      'Debit accounts payable with what it pays off, for the vendor.',
      'Credit the account the money came from, a bank account or a card, as NetSuite posted it.',
      'Credit a discount BMG took for paying early to its own account; payables are debited with it too.',
    ],
    code: 'src/lib/books/bill-payment-rule.ts', docs: 'Bill payments',
  },
  {
    id: 'spending@1', name: 'Checks and card charges', group: 'netsuite',
    from: 'Each check, credit card charge and credit card refund NetSuite has.',
    posts: [
      'Credit the bank account or card the money comes out of with the total, as NetSuite posted it.',
      "Debit each line where the bill rule puts a bill's line, a stock item to its inventory asset account.",
      'A card refund posts the same way, the other way round.',
    ],
    code: 'src/lib/books/spending-rule.ts', docs: 'Checks and card charges',
  },
  {
    id: 'journal_entry@1', name: 'Journal entries', group: 'netsuite',
    from: "Each journal entry NetSuite has, the bookkeeper's and the ones FleetSuite makes included.",
    posts: [
      "Each of its lines for the company, to the same account for the same amount, as the copy of NetSuite's general ledger has it.",
    ],
    note: "One whose lines for a company don't balance on their own isn't posted, and a line of $0 posts nothing.",
    code: 'src/lib/books/journal-entry-rule.ts', docs: 'Journal entries',
  },
  {
    id: 'bank@1', name: 'Bank deposits, transfers and refunds', group: 'netsuite',
    from: 'Each bank deposit, transfer between accounts and customer refund NetSuite has.',
    posts: [
      "Line for line from the copy of NetSuite's general ledger, as a journal entry posts.",
    ],
    code: 'src/lib/books/bank-rule.ts', docs: 'Bank deposits, transfers and refunds',
  },
  {
    id: 'stock@1', name: 'Stock and cost', group: 'netsuite',
    from: "Each item fulfillment, item receipt, inventory adjustment, inventory transfer, assembly build and unbuild NetSuite has, and the cost lines of an invoice or credit memo that moved stock itself.",
    posts: [
      "Line for line from the copy of NetSuite's general ledger, so FleetSuite takes NetSuite's costs as they are.",
    ],
    code: 'src/lib/books/stock-rule.ts', docs: 'Stock and cost',
  },
  {
    id: 'own_invoice@1', name: "FleetSuite's own invoices", group: 'own',
    from: "An invoice FleetSuite made, from FleetSuite's own copy of it.",
    posts: [
      "The invoice rule on FleetSuite's own lines, with the sales tax to the account NetSuite's sales tax has posted to most since January 2025.",
    ],
    code: 'src/lib/books/own-invoice-posting.ts', docs: "Posting FleetSuite's own invoices",
  },
  {
    id: 'own_bill@1', name: "FleetSuite's own bills", group: 'own',
    from: "A bill FleetSuite made from Parts Mail, a CNI vendor invoice, an installer payout or Snap a bill, from Books' own copy of it.",
    posts: [
      "The bill rule on the copy's own lines, for the same vendor.",
    ],
    code: 'src/lib/books/own-bill-posting.ts', docs: "Posting FleetSuite's own fulfillments, receipts and bills",
  },
  {
    id: 'own_fulfillment@1', name: "FleetSuite's own fulfillments", group: 'own',
    from: "A fulfillment FleetSuite made, from its own copy.",
    posts: [
      "Credit each item's inventory asset account and debit its cost of goods sold account, at the item's average cost at its location just before.",
    ],
    code: 'src/lib/books/own-stock-posting.ts', docs: "Posting FleetSuite's own fulfillments, receipts and bills",
  },
  {
    id: 'own_receipt@1', name: "FleetSuite's own receipts", group: 'own',
    from: 'A Receive on the Receiving page that NetSuite took, from its own copy.',
    posts: [
      "Debit each stock item's inventory asset account at the purchase order's price.",
      "Credit the account the company's item receipts hold received stock against until it's billed.",
    ],
    code: 'src/lib/books/own-stock-posting.ts', docs: "Posting FleetSuite's own fulfillments, receipts and bills",
  },
  {
    id: 'own_adjustment@1', name: "FleetSuite's own adjustments", group: 'own',
    from: 'An Inventory Adjust, from its own record.',
    posts: [
      "The change, at the item's average cost at its location just before, onto or off its inventory asset account, against 52000 Inventory Adjustment.",
    ],
    code: 'src/lib/books/own-stock-posting.ts', docs: "FleetSuite's own adjustments",
  },
  {
    id: 'opening_balance@1', name: 'Opening balances', group: 'opening',
    from: "Once for each company, on the day its books go live, dated the last day of the month before.",
    posts: [
      "A line for each account that still differs from NetSuite's own balance at that month's end, bringing it to NetSuite's: the year's income and expenses on their own accounts, earlier years' net income on retained earnings, and receivables and payables customer by customer and vendor by vendor.",
    ],
    note: 'Later ones true up what changed in NetSuite for the months before going live.',
    code: 'src/lib/books/opening-balances.ts', docs: 'Going live',
  },
];

/** What a reversal is, which isn't a rule of its own: gl_reverse_entry posts it (migration 359). */
export const REVERSAL_TEXT =
  "A posted entry is never changed. One that has to come out is reversed: an entry the other way round, each debit a credit, posted with the rule 'reversal' and naming the entry it reverses, which is counted with that entry here. The right entry is then posted on its own.";

export interface WorkedOutRuleInfo {
  id: string;
  name: string;
  what: string;
  code: string;
  /** The switch the piece it works for waits on, when it does. */
  switch?: SwitchPiece;
}

/**
 * Rules that work out what FleetSuite sends to NetSuite or keeps on its own
 * copies. They post nothing themselves: what they make posts by the rules
 * above once it's in NetSuite.
 */
export const WORKED_OUT_RULES: readonly WorkedOutRuleInfo[] = [
  {
    id: 'tax@2', name: 'Sales tax on own invoices',
    what: "Each line is taxed or not (Service items not, an admin's override either way, everything else taxed, a discount as the line above it; shipping and handling NetSuite adds to the invoice not, as freight isn't taxed) at the rate in force at the invoice's location on its day (Books → Sales tax), worked out line by line and rounded half to even, as NetSuite does. A tax-exempt customer pays none.",
    code: 'src/lib/books/own-invoices.ts',
  },
  {
    id: 'tax@1', name: 'Sales tax where no dated rate is set',
    what: "The same, at the one rate in Settings → Sales Tax, where Books → Sales tax has no rate for the location or the location isn't known.",
    code: 'src/lib/books/own-invoices.ts',
  },
  {
    id: 'credit_tax@1', name: 'Sales tax on credit memos',
    what: "Each line credited is taxed as the invoice taxed it, at the invoice's own rate, so the credit gives back the tax the customer paid.",
    code: 'src/lib/credit-memo.ts', switch: 'credit_memos',
  },
  {
    id: 'vendor_credit@1', name: 'Vendor credits',
    what: "An account line is its own amount and a part line its quantity times its rate, rounded half to even to the cent; the total is its lines. It applies to the bills picked, never more than a bill has open nor more than the credit comes to. Bills carry no sales tax, so neither does a credit.",
    code: 'src/lib/vendor-credit.ts', switch: 'vendor_credits',
  },
  {
    id: 'card_charges@1', name: 'Card charges',
    what: "A month's Chase card charges go to NetSuite as one journal entry, two lines a charge: its account and the card's, so the card's side matches Chase's statement line for line. Payments to the card are left out; they're paid from the bank.",
    code: 'src/lib/card-charges.ts', switch: 'card_charges',
  },
  {
    id: 'typed_journal_entry@1', name: 'Typed journal entries',
    what: "An entry is its lines as typed, each to the cent, and must balance. A line to accounts receivable or payable isn't taken, since those need a customer or vendor. A CPA adjustment's memo starts \"CPA adjustment:\".",
    code: 'src/lib/typed-journal-entries.ts', switch: 'journal_entries',
  },
  {
    id: 'inventory_transfer@1', name: 'Inventory transfers',
    what: "A transfer moves stock from one of a company's locations to another: it changes where the stock is, never how much there is or what it's worth.",
    code: 'src/lib/inventory-transfers.ts', switch: 'inventory_transfers',
  },
];

/** Every rule written down, each name@version, the journal's first. */
export const RULE_IDS: readonly string[] = [...POSTING_RULES.map((r) => r.id), ...WORKED_OUT_RULES.map((r) => r.id)];

/**
 * How the rules are written down, as the fingerprint a review keeps is taken
 * of (how-it-works-data.ts takes its SHA-256), so a change to a rule's words
 * shows as a change since the CPA's review as a new rule does.
 */
export function rulesText(): string {
  return JSON.stringify({
    posting: POSTING_RULES.map((r) => [r.id, r.name, r.group, r.from, r.posts, r.note ?? null]),
    worked: WORKED_OUT_RULES.map((r) => [r.id, r.name, r.what]),
  });
}

// ── Who can change what ─────────────────────────────────────────────────

/** Who passes a step's guard. */
export type Holder =
  | { kind: 'feature'; feature: FeatureKey }
  | { kind: 'admin' }
  | { kind: 'superAdmin' }
  | { kind: 'roles'; roles: readonly AppRole[] }
  | { kind: 'books'; need: BooksAccess };

export type StepArea = 'sales' | 'buying' | 'stock' | 'journal' | 'books' | 'people';

export const STEP_AREAS: Readonly<Record<StepArea, string>> = {
  sales: 'Customers',
  buying: 'Vendors and paying',
  stock: 'Stock',
  journal: 'Journal entries',
  books: 'The books themselves',
  people: 'People and access',
};

export interface MoneyStep {
  key: string;
  area: StepArea;
  step: string;
  where: string;
  /** Who passes its guard: anyone who matches any of these… */
  holders: readonly Holder[];
  /** …and this as well. */
  alsoNeeds?: Holder;
  /** The switch it waits on: off, nobody takes it but super admins looking at what it would do. */
  switch?: SwitchPiece;
  /** A second person who has to approve it, and where the database holds them to it. */
  approval?: { text: string; migration: string; check: string };
  /** The rules what it makes posts by. */
  posts?: readonly string[];
  /** The route that takes it, its guard's kind as route-permissions.ts has it, and words its file holds verbatim. */
  route?: { file: string; guard: RouteGuardKind; markers: readonly string[] };
  /** Where the database holds it instead, for a step no route takes. */
  database?: { migration: string; check: string };
  note?: string;
}

const feature = (f: FeatureKey): Holder => ({ kind: 'feature', feature: f });
const ADMIN: Holder = { kind: 'admin' };
const SUPER_ADMIN: Holder = { kind: 'superAdmin' };
const books = (need: BooksAccess): Holder => ({ kind: 'books', need });

const SECOND_SUPER_ADMIN = "A super admin who didn't ask approves it.";

export const MONEY_STEPS: readonly MoneyStep[] = [
  // Customers
  {
    key: 'invoice', area: 'sales', step: 'Make an invoice', where: 'Invoicing → New invoice, scans and graphics jobs',
    holders: [feature('invoicing')], posts: ['invoice@1', 'own_invoice@1'],
    route: { file: 'src/app/api/invoices/new/route.ts', guard: 'feature', markers: ["requireFeature(req, 'invoicing')"] },
  },
  {
    key: 'fulfill_invoice', area: 'sales', step: 'Fulfill and invoice a sales order', where: 'Fulfill & Invoice on a sales order or a won estimate',
    holders: [ADMIN], posts: ['invoice@1', 'own_invoice@1', 'stock@1', 'own_fulfillment@1'],
    route: { file: 'src/app/api/sales-orders/[id]/fulfill-invoice/route.ts', guard: 'admin', markers: ['requireAdmin('] },
  },
  {
    key: 'credit_memo', area: 'sales', step: 'Make a credit memo', where: 'Credit on an invoice',
    holders: [feature('invoicing')], switch: 'credit_memos', posts: ['credit_memo@1'],
    route: { file: 'src/app/api/invoices/credit-memo/route.ts', guard: 'feature', markers: ["requireFeature(req, 'invoicing')", "switchIsOn(service, 'credit_memos')"] },
  },
  {
    key: 'invoice_fix', area: 'sales', step: 'Fix an invoice after it is made', where: 'Fix on an invoice',
    holders: [feature('invoicing')], switch: 'invoice_fixes', posts: ['invoice@1', 'own_invoice@1'],
    route: { file: 'src/app/api/invoices/fix/route.ts', guard: 'feature', markers: ["requireFeature(req, 'invoicing')", "switchIsOn(service, 'invoice_fixes')"] },
  },
  {
    key: 'payment', area: 'sales', step: "Receive a customer's payment", where: 'Payment on an open invoice',
    holders: [feature('invoicing')], switch: 'customer_payments', posts: ['payment@1'],
    route: { file: 'src/app/api/invoices/payment/route.ts', guard: 'feature', markers: ["requireFeature(req, 'invoicing')", "switchIsOn(service, 'customer_payments')"] },
  },
  {
    key: 'deposit', area: 'sales', step: "Take a customer's deposit", where: 'Deposit on a sales order',
    holders: [feature('invoicing')], switch: 'customer_deposits', posts: ['deposit@1'],
    route: { file: 'src/app/api/sales-orders/deposit/route.ts', guard: 'feature', markers: ["requireFeature(req, 'invoicing')", "switchIsOn(service, 'customer_deposits')"] },
  },
  {
    key: 'bank_deposit', area: 'sales', step: 'Deposit payments to the bank', where: 'Invoicing → Invoiced → Bank deposit',
    holders: [feature('invoicing')], switch: 'bank_deposits', posts: ['bank@1'],
    route: { file: 'src/app/api/invoices/bank-deposit/route.ts', guard: 'feature', markers: ["requireFeature(req, 'invoicing')", "switchIsOn(service, 'bank_deposits')"] },
  },
  {
    key: 'customer_terms', area: 'sales', step: "Change a customer's terms or credit limit", where: 'More → Sales → Customer Terms',
    holders: [feature('credit_applications')], switch: 'customer_vendor_details',
    route: { file: 'src/app/api/customer-terms/route.ts', guard: 'feature', markers: ["requireFeature(req, 'credit_applications')", "switchIsOn(service, 'customer_vendor_details')"] },
  },

  // Vendors and paying
  {
    key: 'receive', area: 'buying', step: 'Receive a purchase order', where: 'Receiving',
    holders: [feature('parts_ordering')], posts: ['stock@1', 'own_receipt@1'],
    route: { file: 'src/app/api/po-receipts/route.ts', guard: 'feature', markers: ["requireFeature(req, 'parts_ordering')"] },
  },
  {
    key: 'parts_mail_bill', area: 'buying', step: "Bill a purchase order from the vendor's invoice", where: 'Parts Mail',
    holders: [ADMIN, { kind: 'roles', roles: ['finance'] }], posts: ['bill@1', 'own_bill@1'],
    route: { file: 'src/app/api/parts-mail/create-bill/route.ts', guard: 'role', markers: ["requireRole(req, ['admin', 'finance'])"] },
  },
  {
    key: 'cni_bill', area: 'buying', step: "Bill a CNI vendor's invoice", where: 'CNI → Vendor invoices',
    holders: [ADMIN, { kind: 'roles', roles: ['finance'] }], posts: ['bill@1', 'own_bill@1'],
    route: { file: 'src/app/api/vendor-invoices/workflow/route.ts', guard: 'role', markers: ["requireRole(req, ['finance'])"] },
  },
  {
    key: 'payout_bill', area: 'buying', step: "Bill an installer's payout", where: 'More → Admin → Payouts',
    holders: [ADMIN], posts: ['bill@1', 'own_bill@1'],
    route: { file: 'src/app/api/admin/payouts/route.ts', guard: 'admin', markers: ['requireAdmin('] },
  },
  {
    key: 'snap_bill', area: 'buying', step: 'Snap a bill', where: 'Books → Snap a bill',
    holders: [books('keep')], posts: ['bill@1', 'own_bill@1'],
    route: { file: 'src/app/api/admin/books/snap-a-bill/route.ts', guard: 'books', markers: ["requireBooks(req, 'keep')"] },
  },
  {
    key: 'vendor_credit', area: 'buying', step: "Enter a vendor's credit", where: 'More → Purchasing → Vendor Credits',
    holders: [feature('parts_ordering')], switch: 'vendor_credits', posts: ['bill@1'],
    route: { file: 'src/app/api/purchasing/vendor-credit/route.ts', guard: 'feature', markers: ["requireFeature(req, 'parts_ordering')", "switchIsOn(service, 'vendor_credits')"] },
  },
  {
    key: 'bill_fix', area: 'buying', step: 'Fix a bill after it is made', where: 'More → Purchasing → Fix a Bill',
    holders: [feature('parts_ordering')], switch: 'bill_fixes', posts: ['bill@1', 'own_bill@1'],
    route: { file: 'src/app/api/purchasing/bill-fix/route.ts', guard: 'feature', markers: ["requireFeature(req, 'parts_ordering')", "switchIsOn(service, 'bill_fixes')"] },
  },
  {
    key: 'card_charges', area: 'buying', step: 'Code the card charges', where: 'More → Money & Books → Card Charges',
    holders: [feature('vendor_payments')], switch: 'card_charges', posts: ['journal_entry@1'],
    route: { file: 'src/app/api/card-charges/route.ts', guard: 'feature', markers: ["requireFeature(req, 'vendor_payments')", "switchIsOn(service, 'card_charges')"] },
  },
  {
    key: 'pay_vendors', area: 'buying', step: 'Pay vendors in a payment run, by check or ACH', where: 'More → Money & Books → Pay Vendors',
    holders: [feature('vendor_payments')], switch: 'vendor_payments', posts: ['bill_payment@1'],
    approval: { text: SECOND_SUPER_ADMIN, migration: '488-vendors-paid-in-fleetsuite.sql', check: "IF v_row.asked_by = (p->>'approver')::uuid THEN" },
    route: { file: 'src/app/api/pay-vendors/route.ts', guard: 'feature', markers: ["requireFeature(req, 'vendor_payments')", "switchIsOn(service, 'vendor_payments')"] },
  },
  {
    key: 'vendor_bank', area: 'buying', step: "Enter a vendor's bank numbers for ACH", where: 'Pay Vendors → Bank numbers',
    holders: [SUPER_ADMIN],
    approval: { text: 'A second super admin confirms them on a call-back to the vendor.', migration: '490-vendor-bank-numbers-kept-encrypted.sql', check: 'CONSTRAINT vendor_bank_second_person CHECK (confirmed_by IS NULL OR entered_by IS NULL OR confirmed_by <> entered_by)' },
    route: { file: 'src/app/api/pay-vendors/bank/route.ts', guard: 'superAdmin', markers: ['requireSuperAdmin('] },
  },
  {
    key: 'ach_file', area: 'buying', step: 'Make the ACH file for First Bank', where: "A payment run's ACH file",
    holders: [SUPER_ADMIN], switch: 'vendor_payments',
    route: { file: 'src/app/api/pay-vendors/ach/route.ts', guard: 'superAdmin', markers: ['requireSuperAdmin(', "switchIsOn(service, 'vendor_payments')"] },
  },
  {
    key: 'vendor_details', area: 'buying', step: "Change a vendor's details and 1099 details", where: 'More → Money & Books → Vendor Details',
    holders: [feature('vendor_payments')], switch: 'customer_vendor_details',
    route: { file: 'src/app/api/vendor-details/route.ts', guard: 'feature', markers: ["requireFeature(req, 'vendor_payments')", "switchIsOn(service, 'customer_vendor_details')"] },
  },
  {
    key: 'item_accounts', area: 'buying', step: "Change an item's accounts", where: 'More → Money & Books → Item Accounts',
    holders: [feature('vendor_payments')], switch: 'item_accounts',
    route: { file: 'src/app/api/item-accounts/route.ts', guard: 'feature', markers: ["requireFeature(req, 'vendor_payments')", "switchIsOn(service, 'item_accounts')"] },
  },

  // Stock
  {
    key: 'adjust', area: 'stock', step: 'Adjust stock', where: 'Adjust on the Inventory page',
    holders: [ADMIN], posts: ['stock@1', 'own_adjustment@1'],
    note: "With Approving adjustments switched on, a super admin who didn't ask approves each one first.",
    route: { file: 'src/app/api/inventory/adjust/route.ts', guard: 'admin', markers: ['requireAdmin(', "readSwitch(service, 'adjustment_approvals')"] },
  },
  {
    key: 'adjust_approve', area: 'stock', step: 'Approve an adjustment', where: 'Adjustments to approve on the Inventory page',
    holders: [SUPER_ADMIN], switch: 'adjustment_approvals', posts: ['stock@1', 'own_adjustment@1'],
    approval: { text: "The super admin approving it isn't the one who asked.", migration: '494-inventory-adjustments-approved.sql', check: "IF v_row.asked_by = (p->>'by')::uuid THEN" },
    route: { file: 'src/app/api/inventory/adjust/approvals/route.ts', guard: 'admin', markers: ["getProfileRoles(auth.profile).includes('super_admin')"] },
  },
  {
    key: 'count', area: 'stock', step: 'Count stock', where: 'Counts on the Inventory page',
    holders: [ADMIN], switch: 'stock_counts', posts: ['stock@1'],
    approval: { text: SECOND_SUPER_ADMIN, migration: '499-stock-counts.sql', check: "IF v_row.asked_by = (p->>'by')::uuid THEN" },
    route: { file: 'src/app/api/inventory/counts/route.ts', guard: 'admin', markers: ['requireAdmin(', "switchIsOn(service, 'stock_counts')"] },
  },
  {
    key: 'transfer', area: 'stock', step: 'Move stock between locations', where: 'More → Parts & Inventory → Inventory Transfers',
    holders: [ADMIN], switch: 'inventory_transfers', posts: ['stock@1'],
    route: { file: 'src/app/api/inventory-transfers/route.ts', guard: 'admin', markers: ['requireAdmin(', "switchIsOn(service, 'inventory_transfers')"] },
  },

  // Journal entries
  {
    key: 'journal_entry', area: 'journal', step: 'Type a journal entry', where: 'More → Money & Books → Journal Entries',
    holders: [feature('vendor_payments'), { kind: 'roles', roles: ['cpa', 'super_admin'] }], switch: 'journal_entries', posts: ['journal_entry@1'],
    note: "Anyone with Vendor Payments types in the general journal; the CPA and super admins in the CPA's adjustments.",
    approval: { text: SECOND_SUPER_ADMIN, migration: '469-journal-entries-typed-in-fleetsuite.sql', check: "IF v_row.asked_by = (p->>'approver')::uuid THEN" },
    route: { file: 'src/app/api/journal-entries/route.ts', guard: 'authScoped', markers: ["profileHasFeature(auth.user.id, auth.profile, 'vendor_payments')", 'journalsFor(', "switchIsOn(service, 'journal_entries')"] },
  },
  {
    key: 'rent_mortgage', area: 'journal', step: "Make 1084's rent and mortgage entries", where: 'Books → Rent and mortgage',
    holders: [books('keep')], alsoNeeds: feature('vendor_payments'), switch: 'journal_entries', posts: ['journal_entry@1'],
    route: { file: 'src/app/api/admin/books/rent-and-mortgage/route.ts', guard: 'books', markers: ["requireBooks(req, 'keep')", "profileHasFeature(auth.user.id, auth.profile, 'vendor_payments')", "switchIsOn(service, 'journal_entries')"] },
  },

  // The books themselves
  {
    key: 'read', area: 'books', step: 'Open the books, every report and download', where: 'Books',
    holders: [books('read')],
    route: { file: 'src/app/api/admin/books/reports/route.ts', guard: 'books', markers: ["requireBooks(req, 'read')"] },
  },
  {
    key: 'post_now', area: 'books', step: "Copy from NetSuite and post now, between the two-hourly runs", where: 'Books → Invoices vs NetSuite → Post now',
    holders: [books('keep')],
    route: { file: 'src/app/api/admin/books/invoices/route.ts', guard: 'books', markers: ["requireBooks(req, 'keep')"] },
  },
  {
    key: 'close_month', area: 'books', step: 'Close a month', where: 'Books → Months',
    holders: [books('keep')],
    route: { file: 'src/app/api/admin/books/months/route.ts', guard: 'books', markers: ["requireBooks(req, 'keep')"] },
  },
  {
    key: 'reopen_month', area: 'books', step: 'Reopen a closed month, saying why', where: 'Books → Months',
    holders: [books('owner')],
    route: { file: 'src/app/api/admin/books/months/route.ts', guard: 'books', markers: ["booksAllows(auth.access, 'owner')"] },
  },
  {
    key: 'year_end', area: 'books', step: 'Close or reopen a year', where: 'Books → Year end',
    holders: [books('owner')],
    route: { file: 'src/app/api/admin/books/year-end/route.ts', guard: 'books', markers: ["booksAllows(auth.access, 'owner')"] },
  },
  {
    key: 'mistakes', area: 'books', step: 'Clear a mistake check', where: 'Books → Mistake checks',
    holders: [books('keep')],
    route: { file: 'src/app/api/admin/books/mistake-checks/route.ts', guard: 'books', markers: ["requireBooks(req, 'keep')"] },
  },
  {
    key: 'bank_rec', area: 'books', step: 'Reconcile a bank account', where: 'Books → Bank reconciliation',
    holders: [books('keep')],
    route: { file: 'src/app/api/admin/books/bank-reconciliation/route.ts', guard: 'books', markers: ["requireBooks(req, 'keep')"] },
  },
  {
    key: 'sales_tax_return', area: 'books', step: 'Type in a sales tax return', where: 'Books → Sales tax',
    holders: [books('keep')],
    route: { file: 'src/app/api/admin/books/sales-tax/route.ts', guard: 'books', markers: ["requireBooks(req, 'keep')"] },
  },
  {
    key: 'sales_tax_rates', area: 'books', step: 'Add or remove a sales tax rate', where: 'Books → Sales tax',
    holders: [books('owner')],
    route: { file: 'src/app/api/admin/books/sales-tax/route.ts', guard: 'books', markers: ["booksAllows(auth.access, 'owner')"] },
  },
  {
    key: 'switches', area: 'books', step: 'Switch a piece on or off', where: 'Books → Switches',
    holders: [books('owner')],
    route: { file: 'src/app/api/admin/books/switches/route.ts', guard: 'books', markers: ['requireSuperAdmin('] },
  },
  {
    key: 'go_live', area: 'books', step: "Take a company's books live, which can't be undone", where: 'Books → Going live',
    holders: [books('owner')], posts: ['opening_balance@1'],
    route: { file: 'src/app/api/admin/books/going-live/route.ts', guard: 'books', markers: ['requireSuperAdmin('] },
  },
  {
    key: 'changed_in_netsuite', area: 'books', step: "Keep FleetSuite's record or take a change made in NetSuite", where: 'Books → Changed in NetSuite',
    holders: [books('owner')],
    note: "NetSuite's changes are listed here once FleetSuite's record wins is switched on.",
    route: { file: 'src/app/api/admin/books/changed-in-netsuite/route.ts', guard: 'books', markers: ['requireSuperAdmin('] },
  },
  {
    key: 'own_numbers', area: 'books', step: "Set FleetSuite's own document numbers", where: 'Books → Own numbers',
    holders: [books('owner')],
    note: "FleetSuite's numbers go on its documents once FleetSuite's own numbers is switched on.",
    route: { file: 'src/app/api/admin/books/own-numbers/route.ts', guard: 'books', markers: ['requireSuperAdmin('] },
  },
  {
    key: 'backups', area: 'books', step: 'Back up now, test a restore, download a backup', where: 'Books → Backups',
    holders: [books('owner')],
    route: { file: 'src/app/api/admin/books/backups/route.ts', guard: 'books', markers: ['requireSuperAdmin('] },
  },
  {
    key: 'rules_review', area: 'books', step: 'Mark this description reviewed', where: 'Books → How the books work',
    holders: [{ kind: 'roles', roles: ['cpa', 'super_admin'] }],
    note: "A super admin marks it for a review the CPA did on paper. A review is kept as it was made, with the rules it covered.",
    route: { file: 'src/app/api/admin/books/how-it-works/route.ts', guard: 'books', markers: ["requireBooks(req, 'read')", 'reviewerAs('] },
  },

  // People and access
  {
    key: 'books_roles', area: 'people', step: 'Give someone the bookkeeper or CPA role', where: 'More → Admin → Users',
    holders: [SUPER_ADMIN],
    database: { migration: '483-books-bookkeeper-cpa-roles.sql', check: "'permission denied: only a super admin can give the % role', col" },
  },
  {
    key: 'role_permissions', area: 'people', step: 'Change what a role can do', where: 'More → Admin → Permissions',
    holders: [SUPER_ADMIN],
    route: { file: 'src/app/api/admin/role-permissions/route.ts', guard: 'superAdmin', markers: ['requireSuperAdmin('] },
  },
  {
    key: 'two_step_reset', area: 'people', step: "Reset someone's two-step sign-in", where: 'More → Admin → Users',
    holders: [SUPER_ADMIN],
    route: { file: 'src/app/api/admin/two-step/route.ts', guard: 'superAdmin', markers: ['requireSuperAdmin('] },
  },
];

/** What each level in the books can do (src/lib/books/access.ts). */
export const BOOKS_LEVELS: Readonly<Record<BooksAccess, { name: string; who: string; can: string }>> = {
  owner: {
    name: 'Owner', who: 'Super admins',
    can: 'Everything, and the steps only the owner takes: the switches, going live, keeping or taking a change made in NetSuite, reopening a closed month, closing a year, sales tax rates, own numbers and backups.',
  },
  keep: {
    name: 'Keep the books', who: 'The bookkeeper',
    can: 'Everything else: copying from NetSuite and posting, closing a month, clearing mistake checks, Snap a bill, bank reconciliations and sales tax returns.',
  },
  read: {
    name: 'Read', who: 'The CPA',
    can: "Every Books page and download, changing nothing in the books. The CPA's own adjustments are typed on Journal entries, and the CPA marks this description reviewed.",
  },
};

const BOOKS_WHO: Readonly<Record<BooksAccess, string>> = {
  owner: 'super admins',
  keep: 'super admins and the bookkeeper',
  read: 'super admins, the bookkeeper and the CPA',
};

const roleText = (r: AppRole): string => (r === 'super_admin' ? 'super admins' : r === 'cpa' ? 'the CPA' : r === 'bookkeeper' ? 'the bookkeeper' : `${ROLE_LABELS[r]} people`);

const holderTexts = (h: Holder): string[] => {
  switch (h.kind) {
    case 'feature': return [`anyone with ${FEATURES[h.feature]}`];
    case 'admin': return ['admins'];
    case 'superAdmin': return ['super admins'];
    case 'roles': return h.roles.map(roleText);
    case 'books': return [BOOKS_WHO[h.need]];
  }
};

const orList = (parts: string[]) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`);

/** Who can take a step, in words, from its holders: "Anyone with Invoicing", "Admins or Finance / AP people". */
export function whoText(step: Pick<MoneyStep, 'holders' | 'alsoNeeds'>): string {
  const text = orList(step.holders.flatMap(holderTexts));
  const also = step.alsoNeeds
    ? `, who also have ${step.alsoNeeds.kind === 'feature' ? FEATURES[step.alsoNeeds.feature] : orList(holderTexts(step.alsoNeeds))}`
    : '';
  return text.charAt(0).toUpperCase() + text.slice(1) + also;
}

/** Someone as the guards see them: their roles, and what the Permissions screen gives them. */
export interface PersonAccess {
  roles: readonly string[];
  features: ReadonlySet<string>;
}

const isAdmin = (roles: readonly string[]) => roles.includes('admin') || roles.includes('super_admin');

function booksLevel(roles: readonly string[]): BooksAccess | null {
  if (roles.includes('super_admin')) return 'owner';
  if (roles.includes('bookkeeper')) return 'keep';
  if (roles.includes('cpa')) return 'read';
  return null;
}

const RANK: Record<BooksAccess, number> = { read: 1, keep: 2, owner: 3 };

/** Does this person pass a holder, as the route's guard would? */
export function holds(h: Holder, p: PersonAccess): boolean {
  switch (h.kind) {
    case 'feature': return p.features.has(h.feature);
    case 'admin': return isAdmin(p.roles);
    case 'superAdmin': return p.roles.includes('super_admin');
    case 'roles': return h.roles.some((r) => p.roles.includes(r));
    case 'books': {
      const level = booksLevel(p.roles);
      return !!level && RANK[level] >= RANK[h.need];
    }
  }
}

/** Can this person take the step, switches aside? */
export function canTake(step: Pick<MoneyStep, 'holders' | 'alsoNeeds'>, p: PersonAccess): boolean {
  return step.holders.some((h) => holds(h, p)) && (!step.alsoNeeds || holds(step.alsoNeeds, p));
}

// ── What the database won't let anyone do ───────────────────────────────

export interface DatabaseRule {
  text: string;
  /** The migration that holds it, and words of the refusal as it has them. */
  migration: string;
  check: string;
}

/** Refused for any writer, FleetSuite's server and someone in the database alike (docs/books.md "Rules the database enforces"). */
export const DATABASE_RULES: readonly DatabaseRule[] = [
  { text: 'An entry has at least two lines and its debits equal its credits, checked when it posts.', migration: '359-books-ledger-core.sql', check: "'gl: entry % does not balance: debits % vs credits %'" },
  { text: 'Each line has an amount on one side only, above zero, in whole cents.', migration: '359-books-ledger-core.sql', check: "'gl: line % has more than two decimal places'" },
  { text: 'A posted entry or line is never changed or deleted; one that has to come out is reversed.', migration: '359-books-ledger-core.sql', check: "'gl: % rows can't be changed or deleted; post a reversal instead'" },
  { text: 'Lines are added only while their entry is being posted.', migration: '359-books-ledger-core.sql', check: "lines can only be added while it is being posted" },
  { text: 'A reversal names the entry it reverses, in the same company; an entry is reversed once at most, and a reversal is never reversed.', migration: '359-books-ledger-core.sql', check: "'gl: entry % is already reversed'" },
  { text: 'A closed month takes no entries, and reopening one needs a reason; each company has its own months.', migration: '359-books-ledger-core.sql', check: "'gl: reopening % needs a reason'" },
  { text: 'In a closed year every month stays closed until the year is reopened, and years close and reopen in order.', migration: '502-books-year-end.sql', check: 'stays closed until the year is reopened' },
  { text: 'A typed entry posts to no control account (receivables, payables, inventory) and no inactive account: only the documents behind them do.', migration: '387-books-retired-accounts.sql', check: "'gl: account % (%) is posted only by its own documents, not by a typed entry'" },
  { text: "An account kept to one company can't be used by the other, a heading account takes no postings, and once an account has postings its type and company stay.", migration: '359-books-ledger-core.sql', check: "has postings, so its type and company can't change" },
  { text: 'The same document never posts twice: each entry has its own key, and a post that is tried again finds the entry already there.', migration: '359-books-ledger-core.sql', check: "'gl: idempotency_key is required'" },
  { text: "Once a company is live its live date can't change, entries dated before it are refused but for opening balances, and the journal can't be emptied.", migration: '359-books-ledger-core.sql', check: "can't be emptied once any company's books are live" },
  { text: 'The change history, backups, restore drills and these reviews stay as they were made.', migration: '508-books-money-changes.sql', check: "'books: the change history stays'" },
  { text: 'Only a super admin gives the bookkeeper or CPA role.', migration: '483-books-bookkeeper-cpa-roles.sql', check: "'permission denied: only a super admin can give the % role', col" },
];

/** Who reads and writes the books' tables. */
export const DATABASE_ACCESS =
  "Only FleetSuite's server reads or writes the books' tables and functions: row-level security is on with no policies, and the app's own database roles have no rights to them. People reach the books only through FleetSuite's screens, each step behind the guard above.";

// ── Controls ─────────────────────────────────────────────────────────────

export interface Control {
  name: string;
  text: string;
  /** Where it's set or seen. */
  where: string;
}

export const CONTROLS: readonly Control[] = [
  {
    name: 'Change history',
    text: "Every change to a books table is recorded: the table, the row, what changed, who and how (FleetSuite's screens, its server, or straight in the database). One made outside FleetSuite shows in red, and the morning check tells the super admins once. Locked columns such as bank numbers are named, never copied.",
    where: 'Books → Change history',
  },
  {
    name: 'A second person',
    text: "Payment runs, typed journal entries, counts and, once switched on, inventory adjustments need a super admin who didn't ask; a vendor's bank numbers need a second super admin's call-back. The database refuses an approval by whoever asked.",
    where: 'Each step above',
  },
  {
    name: 'Two-step sign-in',
    text: 'People with a money role (super admin, executive, finance, bookkeeper, CPA) give a code from an authenticator app when they sign in, once switched on; anyone who set one up already gives it.',
    where: 'Settings → Two-step sign-in, and Books → Switches',
  },
  {
    name: 'Checks against NetSuite',
    text: "Twice each morning the daily check puts every month of each company's books, each item's count, each customer's and vendor's balance and each of FleetSuite's own documents next to NetSuite's, and tells the super admins what differs.",
    where: 'Books → Differences, and the morning alert',
  },
  {
    name: 'Mistake checks',
    text: "Each night the copies of NetSuite's bills, checks and card charges are looked through for likely mistakes, such as a bill entered twice, for the bookkeeper to clear or fix.",
    where: 'Books → Mistake checks',
  },
  {
    name: 'NetSuite feed',
    text: 'Every send to NetSuite is recorded, what NetSuite took, refused or left unsure, and the morning check names unsure ones.',
    where: 'Books → NetSuite feed',
  },
  {
    name: 'New alerts',
    text: 'Alerts about money (outside changes, ACH setups, bank numbers, two-step set-ups and resets, approvals asked) go to the super admins, and every new alert to Craig as well.',
    where: 'The bell, push and email',
  },
];

// ── Jobs that run by themselves ──────────────────────────────────────────

export interface BooksJob {
  /** As vercel.json has it. */
  path: string;
  schedule: string;
  name: string;
  what: string;
}

export const BOOKS_JOBS: readonly BooksJob[] = [
  { path: '/api/cron/books-netsuite-deposits', schedule: '16 1,3,5,7,9,11,13,15,17,19,21,23 * * *', name: 'Copy deposits', what: "Copies NetSuite's customer deposits and their applications." },
  { path: '/api/cron/books-netsuite-bill-payments', schedule: '21 1,3,5,7,9,11,13,15,17,19,21,23 * * *', name: 'Copy bill payments', what: "Copies NetSuite's bill payments." },
  { path: '/api/cron/books-netsuite-gl', schedule: '26 1,3,5,7,9,11,13,15,17,19,21,23 * * *', name: "Copy NetSuite's general ledger", what: "Copies NetSuite's general ledger from 2025 and checks it month by month against NetSuite's own totals." },
  { path: '/api/cron/books-netsuite-open-items', schedule: '29 1,3,5,7,9,11,13,15,17,19,21,23 * * *', name: 'Copy what is open', what: "Copies what NetSuite has open on its invoices, credit memos, bills and bill credits, for NetSuite's side of the agings." },
  { path: '/api/cron/books-netsuite-spending', schedule: '33 1,3,5,7,9,11,13,15,17,19,21,23 * * *', name: 'Copy checks and card charges', what: "Copies NetSuite's checks, card charges and card refunds." },
  { path: '/api/cron/books-netsuite-bills', schedule: '39 1,3,5,7,9,11,13,15,17,19,21,23 * * *', name: 'Copy bills', what: "Copies NetSuite's vendor bills and bill credits." },
  { path: '/api/cron/books-netsuite-stock', schedule: '43 1,3,5,7,9,11,13,15,17,19,21,23 * * *', name: 'Copy stock moves', what: "Copies NetSuite's fulfillments, receipts, adjustments, transfers and builds." },
  { path: '/api/cron/books-invoice-posting', schedule: '48 1,3,5,7,9,11,13,15,17,19,21,23 * * *', name: 'The posting run', what: 'Posts every document copied since the last run by the rules above, and the opening entry once a company is live.' },
  { path: '/api/cron/books-invoice-pdfs', schedule: '56 1,3,5,7,9,11,13,15,17,19,21,23 * * *', name: 'Invoice PDFs', what: "Attaches FleetSuite's own PDF to each invoice in NetSuite, once switched on." },
  { path: '/api/cron/books-backup', schedule: '11 8 * * *', name: 'Backup', what: "Copies every table of the books into a zip in BMG's own file storage, checks it reads back to the same trial balance, and keeps it. Every backup is kept." },
  { path: '/api/cron/books-restore-drill', schedule: '51 8 * * *', name: 'Restore drill', what: "Restores the newest good backup into an empty scratch copy of the books and checks it: every row back, the journal balancing, the trial balance the same." },
  { path: '/api/cron/books-mistake-checks', schedule: '46 9 * * *', name: 'Mistake checks', what: "Looks through the copies of NetSuite's bills, checks and card charges for likely mistakes." },
  { path: '/api/cron/books-daily-check', schedule: '58 9,13 * * *', name: 'Daily check', what: "Puts the books next to NetSuite's, and the backup's and drill's last runs, and tells the super admins what's wrong." },
];

const centralClock = (utcHour: number, minute: number, on: Date): string => {
  const at = new Date(Date.UTC(on.getUTCFullYear(), on.getUTCMonth(), on.getUTCDate(), utcHour, minute));
  return at.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
};

/** When a job runs, in words, its clock times Central as they fall on `on` (daylight saving moves them an hour). */
export function scheduleText(schedule: string, on: Date): string {
  const [minute, hours] = schedule.split(/\s+/);
  const m = Number(minute);
  const hourList = hours.split(',').map(Number);
  if (hourList.length >= 12) return `Every two hours, at ${String(m).padStart(2, '0')} past`;
  const times = hourList.map((h) => centralClock(h, m, on));
  return `Every day at ${times.join(' and ')} Central`;
}

// ── What this is ─────────────────────────────────────────────────────────

/** What FleetSuite's books are, before anything else. */
export const ABOUT_TEXT =
  "FleetSuite keeps its own double-entry books for BMG and 1084, in its own database next to NetSuite: a chart of accounts, a journal of entries that each balance, and months and years that close. Through 2027 documents still go to NetSuite too, and FleetSuite's books are checked against NetSuite's every morning, until the full cutover leaves FleetSuite's as the only books.";

/** The words that open each part, on the page and in the PDF. */
export const PART_TEXT = {
  written: "It's written next to FleetSuite's code and checked against it each time the code changes, so it says what the code does; what the books hold (who holds each step, what each rule has posted, the switches, the last backup) is read from them as of the date on it.",
  rules: 'Every entry in the journal is posted by one of these rules, and keeps the rule and its version (name@version) it was posted by. A rule whose words change gets a new version, so an entry always says which words it was posted under.',
  workedOut: "These post nothing themselves: they work out what FleetSuite sends to NetSuite or keeps on its own copies, and what they make posts by the rules above once it's in NetSuite.",
  steps: "Each step is guarded where it's taken: FleetSuite's server checks who someone is, from their roles and what More → Admin → Permissions gives them, before it takes the step, and the database holds some steps to it as well. A step that waits on a switch is taken by nobody while the switch is off, except super admins looking at what it would do; who holds each step now is shown switches aside.",
  database: "The database itself refuses these, for anyone writing to it: FleetSuite's server, or someone working in the database directly.",
  switches: 'Pieces that move money, send to NetSuite, change how staff work or face customers were built switched off. Only a super admin switches one, on Books → Switches, and each switch is kept with who changed it and when.',
  review: "Once BMG's CPA has read this description, they sign the PDF and mark it reviewed on Books → How the books work; a super admin can mark it for a review the CPA signed on paper. FleetSuite keeps who marked it, when and the rules it covered, and shows when a rule changes after.",
} as const;

// ── Backups and records ──────────────────────────────────────────────────

export const BACKUP_TEXT: readonly string[] = [
  "Every night FleetSuite copies every table of the books into one zip in BMG's own file storage, outside the database: each table as a CSV file, the journal as an Excel workbook to read, a manifest naming each file's columns, their types and the key, how many rows and a fingerprint (SHA-256) of each, and a README saying how to restore it.",
  'Before a backup is kept it is read back and its journal added up to the same trial balance as the books. Every backup is kept.',
  'Every night after it, the restore drill builds an empty copy of the books from their migrations, restores the newest good backup into it and checks every row came back and the journal balances to the same trial balance.',
  "The morning check tells the super admins when a backup or a drill didn't work or hasn't run. Vendors' bank numbers are in a backup only as FleetSuite encrypted them, and the key that reads them isn't.",
];

export const RECORDS_KEPT: readonly string[] = [
  "The journal: every entry with its date, company, lines, the document it came from (its kind and NetSuite's id), the rule that posted it and when, and who posted it for one typed by hand.",
  "The copies of NetSuite's general ledger, documents and lists the entries were worked out from, and FleetSuite's own copies of the documents it made.",
  "Each month's and year's close, with who and why, the switches, the sends to NetSuite, the change history, the backups and drills, and the CPA's reviews.",
];

/**
 * What the IRS asks of records kept in software, and where FleetSuite
 * answers it. Rev. Proc. 98-25 is the IRS's; BMG's CPA says what applies.
 */
export const IRS_RECORDS: { intro: string; asks: ReadonlyArray<{ ask: string; answer: string }> } = {
  intro: "The IRS's rules for records kept in software (Revenue Procedure 98-25) ask a business to keep them readable and in a form that can be processed for as long as they may matter for a tax return, with enough detail to trace each amount in the books to its document, and to keep a description of the system. Books → How the books work and its PDF are that description, as of the date on them; BMG's CPA says what else applies.",
  asks: [
    { ask: 'How records are made, changed and kept', answer: 'What posts what, the rules the database holds, and the jobs that run by themselves, above.' },
    { ask: 'Controls that keep them accurate and stop unauthorized changes', answer: 'Who can change what, the second person, two-step sign-in, the change history and the checks against NetSuite.' },
    { ask: 'Tracing an amount to its document', answer: "Each journal entry names the document it came from and the rule that posted it; Books' reports open each account's documents." },
    { ask: 'The chart of accounts', answer: 'At the end of the PDF, each account with its type, company and whether it is active.' },
    { ask: 'How the files are laid out', answer: "Each backup's manifest names every table's columns, their types and its key, and its README how to restore it." },
    { ask: 'Kept readable', answer: 'Every nightly backup is kept, as CSV files and an Excel workbook, and one is restored every night to prove it reads.' },
  ],
};

// ── The CPA's review ─────────────────────────────────────────────────────

/** Who can mark the description reviewed: the CPA, or a super admin for a review the CPA did on paper. */
export type ReviewedAs = 'cpa' | 'super_admin';

export const NOTE_MAX = 600;

export interface ReviewRow {
  reviewedAt: string;
  reviewedByName: string;
  reviewedAs: ReviewedAs;
  rules: readonly string[];
  fingerprint: string;
  note: string | null;
}

export interface ReviewState {
  state: 'never' | 'current' | 'changed';
  last: ReviewRow | null;
  /** Rules written down since the review. */
  added: string[];
  /** Rules the review had that are gone. */
  gone: string[];
  /** The words changed with no rule added or gone. */
  reworded: boolean;
}

/** The last review next to the rules as they're written now. */
export function reviewState(last: ReviewRow | null, now: { rules: readonly string[]; fingerprint: string }): ReviewState {
  if (!last) return { state: 'never', last: null, added: [], gone: [], reworded: false };
  const had = new Set(last.rules);
  const has = new Set(now.rules);
  const added = now.rules.filter((r) => !had.has(r));
  const gone = last.rules.filter((r) => !has.has(r));
  const same = last.fingerprint === now.fingerprint;
  return { state: same ? 'current' : 'changed', last, added, gone, reworded: !same && added.length === 0 && gone.length === 0 };
}

/** A review's note as the table takes it (migration 510): trimmed, null when empty. Refuses one too long. */
export function cleanNote(raw: unknown): { note: string | null } | { error: string } {
  if (raw === undefined || raw === null) return { note: null };
  if (typeof raw !== 'string') return { error: 'A note is words.' };
  const note = raw.trim();
  if (!note) return { note: null };
  if (note.length > NOTE_MAX) return { error: `A note is ${NOTE_MAX} characters at most.` };
  return { note };
}

// ── What the page and the PDF show ───────────────────────────────────────

export interface RuleUse {
  company: string;
  entries: number;
  reversed: number;
  firstDate: string;
  lastDate: string;
}

export interface CompanyView {
  code: string;
  name: string;
  liveFrom: string | null;
  /** The last month closed, YYYY-MM, or null. */
  closedThrough: string | null;
  yearsClosed: number[];
}

export interface StepView {
  key: string;
  area: StepArea;
  step: string;
  where: string;
  who: string;
  note: string | null;
  approval: string | null;
  posts: string[];
  switchName: string | null;
  /** Null when it waits on no switch. */
  switchOn: boolean | null;
  /** Who can take it now, switches aside; null when people couldn't be read. */
  people: string[] | null;
}

export interface TwoStepPerson {
  name: string;
  roles: string;
  /** Whether they've set up an authenticator; null when it couldn't be read. */
  setUp: boolean | null;
}

/** The account types the chart takes (migration 359), by name. */
export const ACCOUNT_TYPE_NAMES: Readonly<Record<string, string>> = {
  bank: 'Bank', accounts_receivable: 'Accounts receivable', other_current_asset: 'Other current asset',
  fixed_asset: 'Fixed asset', other_asset: 'Other asset', unbilled_receivable: 'Unbilled receivable',
  deferred_expense: 'Deferred expense', accounts_payable: 'Accounts payable', credit_card: 'Credit card',
  other_current_liability: 'Other current liability', long_term_liability: 'Long-term liability',
  deferred_revenue: 'Deferred revenue', equity: 'Equity', income: 'Income', other_income: 'Other income',
  cost_of_goods_sold: 'Cost of goods sold', expense: 'Expense', other_expense: 'Other expense',
};

export interface AccountRow {
  number: string;
  name: string;
  /** Its type by name. */
  type: string;
  /** The company it's kept to, or "Both". */
  company: string;
  active: boolean;
  /** A heading takes no postings; the accounts under it do. */
  heading: boolean;
  /** Receivables, payables and inventory: posted only by their documents. */
  control: boolean;
}

export interface HowItWorksView {
  asOf: string;
  about: string;
  companies: CompanyView[];
  rules: Array<PostingRuleInfo & { use: RuleUse[] }>;
  /** Rules the journal has posted by that aren't written down. */
  unwritten: Array<{ company: string; rule: string; entries: number }>;
  workedOut: Array<WorkedOutRuleInfo & { switchName: string | null; switchOn: boolean | null }>;
  reversals: string;
  steps: StepView[];
  levels: Array<{ level: BooksAccess; name: string; who: string; can: string; people: string[] | null }>;
  twoStep: { on: boolean | null; people: TwoStepPerson[] | null };
  database: string[];
  databaseAccess: string;
  controls: Control[];
  switches: Array<{ name: string; what: string; on: boolean; changedAt: string | null; later: string | null }> | null;
  jobs: Array<{ name: string; what: string; when: string }>;
  lastPosting: string | null;
  lastCopy: string | null;
  backups: { text: string[]; lastMade: string | null; lastDrillPassed: string | null; problem: string | null };
  records: string[];
  irs: typeof IRS_RECORDS;
  review: ReviewState & { fingerprint: string; canMark: boolean };
  accounts: AccountRow[] | null;
  /** What couldn't be read, each a sentence; the rest of the page still shows. */
  problems: string[];
}
