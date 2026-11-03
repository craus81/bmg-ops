// How the books work, written down (Books part 88): the words are held to
// the code that does the work, so the page can't say one thing while the
// code does another without a test failing. Every posting rule the code has
// is written down and nothing else is, and a rule's version moving on fails
// here until its words are looked at again; each step's guard is the one its
// route carries, and every Books step that changes something is written
// down or named below with why not; each refusal's words are the
// database's own; the jobs are vercel.json's.
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROUTE_GUARDS } from '@/lib/route-permissions';
import { isSwitchPiece } from './switches';
import {
  BOOKS_JOBS, DATABASE_RULES, MONEY_STEPS, POSTING_RULES, RULE_IDS, WORKED_OUT_RULES,
  canTake, cleanNote, holds, reviewState, rulesText, scheduleText, whoText,
  type Holder, type MoneyStep, type ReviewRow,
} from './how-it-works';
import { INVOICE_RULE, CREDIT_MEMO_RULE } from './invoice-rule';
import { PAYMENT_RULE } from './payment-rule';
import { DEPOSIT_RULE } from './deposit-rule';
import { BILL_RULE } from './bill-rule';
import { BILL_PAYMENT_RULE } from './bill-payment-rule';
import { SPENDING_RULE } from './spending-rule';
import { JOURNAL_ENTRY_RULE } from './journal-entry-rule';
import { BANK_RULE } from './bank-rule';
import { STOCK_RULE } from './stock-rule';
import { OWN_INVOICE_RULE } from './own-invoice-posting';
import { OWN_BILL_RULE } from './own-bill-posting';
import { OWN_ADJUSTMENT_RULE, OWN_FULFILLMENT_RULE, OWN_INVOICE_COST_RULE, OWN_RECEIPT_RULE } from './own-stock-posting';
import { OWN_CREDIT_MEMO_RULE } from './own-credit-memo-posting';
import { OPENING_RULE } from './opening-balances';
import { OWN_TAX_RULE, SETTINGS_TAX_RULE } from './own-invoices';
import { CREDIT_TAX_RULE } from '@/lib/credit-memo';
import { VENDOR_CREDIT_RULE } from '@/lib/vendor-credit';
import { CARD_CHARGE_RULE } from '@/lib/card-charges';
import { TYPED_JOURNAL_RULE } from '@/lib/typed-journal-entries';
import { TRANSFER_RULE } from '@/lib/inventory-transfers';

const ROOT = path.resolve(__dirname, '../../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
/** A migration's text as Postgres reads it: '' inside a string is one '. */
const migration = (name: string) => read(`migrations/${name}`).replace(/''/g, "'");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

describe('the posting rules, written down', () => {
  it("has each rule the journal posts by, at the version the code posts it with, and so each version's words get looked at again", () => {
    expect(POSTING_RULES.map((r) => r.id)).toEqual([
      INVOICE_RULE, CREDIT_MEMO_RULE, PAYMENT_RULE, DEPOSIT_RULE, BILL_RULE, BILL_PAYMENT_RULE, SPENDING_RULE,
      JOURNAL_ENTRY_RULE, BANK_RULE, STOCK_RULE, OWN_INVOICE_RULE, OWN_CREDIT_MEMO_RULE, OWN_BILL_RULE, OWN_FULFILLMENT_RULE,
      OWN_RECEIPT_RULE, OWN_ADJUSTMENT_RULE, OWN_INVOICE_COST_RULE, OPENING_RULE,
    ]);
    expect(WORKED_OUT_RULES.map((r) => r.id)).toEqual([
      OWN_TAX_RULE, SETTINGS_TAX_RULE, CREDIT_TAX_RULE, VENDOR_CREDIT_RULE, CARD_CHARGE_RULE, TYPED_JOURNAL_RULE, TRANSFER_RULE,
    ]);
  });

  it('has every rule the code declares and no other, so a new one has to be written down', () => {
    const declared = new Set<string>();
    const used = new Set<string>();
    for (const file of sourceFiles('src')) {
      if (file.startsWith('src/lib/books/how-it-works')) continue;
      const text = read(file);
      for (const m of text.matchAll(/export const [A-Z_]+_RULE = '([a-z_]+@\d+)'/g)) declared.add(m[1]);
      for (const m of text.matchAll(/'([a-z_]+@\d+)'/g)) used.add(m[1]);
    }
    expect([...declared].sort()).toEqual([...RULE_IDS].sort());
    expect([...used].filter((id) => !RULE_IDS.includes(id))).toEqual([]);
    expect(new Set(RULE_IDS).size).toBe(RULE_IDS.length);
  });

  it("points at the file each is worked out in, which has it, and its section of docs/books.md", () => {
    const headings = new Set(read('docs/books.md').split('\n').filter((l) => /^#{2,4} /.test(l)).map((l) => l.replace(/^#+ /, '')));
    for (const r of POSTING_RULES) {
      expect(read(r.code), r.id).toContain(`'${r.id}'`);
      expect(headings.has(r.docs), `${r.id}: docs/books.md has no heading "${r.docs}"`).toBe(true);
      expect(r.posts.length, r.id).toBeGreaterThan(0);
    }
    for (const r of WORKED_OUT_RULES) {
      expect(read(r.code), r.id).toContain(`'${r.id}'`);
      if (r.switch) expect(isSwitchPiece(r.switch), r.id).toBe(true);
    }
  });

  it('fingerprints the words, so a change to them shows since a review', () => {
    const text = rulesText();
    const has = (words: string) => expect(text).toContain(JSON.stringify(words));
    for (const r of POSTING_RULES) {
      has(r.id);
      has(r.from);
      for (const line of r.posts) has(line);
    }
    for (const r of WORKED_OUT_RULES) has(r.what);
  });
});

/**
 * The holders a route's guard lets through, from the guard's own words,
 * for the guards that say it outright; null where the step names them by
 * hand (a route that works out who inside, as typed journal entries do).
 */
function guardHolders(s: MoneyStep): { holders: Holder[]; alsoNeeds?: Holder } | null {
  const markers = s.route!.markers.join('\n');
  const also = /profileHasFeature\(auth\.user\.id, auth\.profile, '([a-z_]+)'\)/.exec(markers);
  const alsoNeeds = also ? ({ kind: 'feature', feature: also[1] } as Holder) : undefined;
  switch (s.route!.guard) {
    case 'feature': {
      const key = /requireFeature\(req, '([a-z_]+)'\)/.exec(markers)![1];
      return { holders: [{ kind: 'feature', feature: key } as Holder] };
    }
    case 'admin':
      return markers.includes("getProfileRoles(auth.profile).includes('super_admin')")
        ? { holders: [{ kind: 'superAdmin' }] }
        : { holders: [{ kind: 'admin' }] };
    case 'superAdmin':
      return { holders: [{ kind: 'superAdmin' }] };
    case 'role': {
      const roles = /requireRole\(req, \[([^\]]+)\]\)/.exec(markers)![1].split(',').map((r) => r.trim().replace(/'/g, ''));
      return { holders: [{ kind: 'admin' }, ...(roles.filter((r) => r !== 'admin').length ? [{ kind: 'roles', roles: roles.filter((r) => r !== 'admin') } as Holder] : [])] };
    }
    case 'books': {
      // Marking the description reviewed: the CPA, or a super admin for a review done on paper (reviewerAs).
      if (markers.includes('reviewerAs(')) return { holders: [{ kind: 'roles', roles: ['cpa', 'super_admin'] }] };
      const need = markers.includes('requireSuperAdmin(') || markers.includes("booksAllows(auth.access, 'owner')")
        ? 'owner'
        : markers.includes("requireBooks(req, 'keep')") ? 'keep' : 'read';
      return { holders: [{ kind: 'books', need }], ...(alsoNeeds ? { alsoNeeds } : {}) };
    }
    default:
      return null;
  }
}

/** The markers guardHolders reads to tell who, past the route's first check. */
const WHO_MARKERS = ['reviewerAs(', "getProfileRoles(auth.profile).includes('super_admin')", "booksAllows(auth.access, 'owner')", 'profileHasFeature('];

describe('who can change what, held to the routes', () => {
  it('names each step once', () => {
    expect(new Set(MONEY_STEPS.map((s) => s.key)).size).toBe(MONEY_STEPS.length);
  });

  it("has each step that makes or fixes an invoice post its cost from FleetSuite's own copy too: the invoice's, or its order's fulfillment's", () => {
    const invoicing = MONEY_STEPS.filter((s) => s.posts?.includes(OWN_INVOICE_RULE));
    expect(invoicing.map((s) => s.key)).toEqual(expect.arrayContaining(['invoice', 'fulfill_invoice', 'invoice_fix']));
    for (const s of invoicing) {
      expect(s.posts!.includes(OWN_INVOICE_COST_RULE) || s.posts!.includes(OWN_FULFILLMENT_RULE), s.key).toBe(true);
    }
    // An invoice made without a sales order takes its stock itself, so making one, or fixing one, posts its cost.
    for (const key of ['invoice', 'invoice_fix']) expect(MONEY_STEPS.find((s) => s.key === key)!.posts, key).toContain(OWN_INVOICE_COST_RULE);
  });

  for (const s of MONEY_STEPS) {
    it(`${s.key}: its route carries the guard it says, and lets through who it says`, () => {
      expect(!!s.route !== !!s.database, 'a route or the database, one of them').toBe(true);
      if (s.switch) expect(isSwitchPiece(s.switch), s.switch).toBe(true);
      for (const id of s.posts ?? []) expect(POSTING_RULES.some((r) => r.id === id), id).toBe(true);
      if (s.approval) expect(migration(s.approval.migration)).toContain(s.approval.check);
      if (s.database) {
        expect(migration(s.database.migration)).toContain(s.database.check);
        return;
      }
      const route = s.route!;
      expect(ROUTE_GUARDS[route.file], `${route.file} has no guard in route-permissions.ts`).toBeDefined();
      expect(ROUTE_GUARDS[route.file].kind).toBe(route.guard);
      // What else decides who is in route-permissions.ts too, so the guard test holds the route to it.
      for (const m of route.markers.filter((x) => WHO_MARKERS.some((w) => x.includes(w)))) {
        expect(ROUTE_GUARDS[route.file].contains, `route-permissions.ts doesn't hold ${m} for ${route.file}`).toContain(m);
      }
      const text = read(route.file);
      for (const m of route.markers) expect(text, `${route.file} doesn't hold ${m}`).toContain(m);
      if (s.switch) expect(text).toMatch(new RegExp(`(switchIsOn|readSwitch)\\([^)]*'${s.switch}'\\)`));
      const expected = guardHolders(s);
      if (expected) {
        expect(s.holders).toEqual(expected.holders);
        expect(s.alsoNeeds).toEqual(expected.alsoNeeds);
      }
    });
  }

  it('typed journal entries: anyone with Vendor Payments in the general journal, the CPA and super admins in theirs, as journalsFor has it', () => {
    const s = MONEY_STEPS.find((x) => x.key === 'journal_entry')!;
    const code = read('src/lib/typed-journal-entries.ts');
    expect(code).toContain("(j === 'general' ? who.payments : who.hasRole('cpa') || who.hasRole('super_admin'))");
    expect(s.holders).toEqual([{ kind: 'feature', feature: 'vendor_payments' }, { kind: 'roles', roles: ['cpa', 'super_admin'] }]);
  });

  // Books routes whose guard lets someone change something, but which aren't
  // a step of their own on the page, and why. A new one fails until it's
  // written down as a step or named here.
  const NOT_A_STEP: Record<string, string> = {
    'src/app/api/admin/books/1099s/route.ts': "reads NetSuite's 1099 report and makes the IRIS file; nothing in the books changes",
    'src/app/api/admin/books/accounts/route.ts': "copies NetSuite's chart of accounts now, as the two-hourly copy does",
    'src/app/api/admin/books/agings/route.ts': "copies what NetSuite has open now, as the two-hourly copy does",
    'src/app/api/admin/books/backups/download/route.ts': 'downloads a backup, which the Backups step covers',
    'src/app/api/admin/books/bill-payments/route.ts': "copies NetSuite's bill payments now, as the two-hourly copy does",
    'src/app/api/admin/books/bills/route.ts': "copies NetSuite's bills now, as the two-hourly copy does",
    'src/app/api/admin/books/deposits/route.ts': "copies NetSuite's deposits now, as the two-hourly copy does",
    'src/app/api/admin/books/lists/route.ts': "copies NetSuite's lists now, as the two-hourly copy does",
    'src/app/api/admin/books/netsuite-feed/route.ts': "notes that someone looked for a send in NetSuite; nothing in the books changes",
    'src/app/api/admin/books/own-invoices/pdf/route.ts': "downloads FleetSuite's PDF of an invoice, or sends it to NetSuite again once Invoice PDFs is on",
    'src/app/api/admin/books/reports/builder/route.ts': 'saves a report layout; nothing in the books changes',
    'src/app/api/admin/books/spending/route.ts': "copies NetSuite's checks and card charges now, as the two-hourly copy does",
    'src/app/api/admin/books/stock/route.ts': "copies NetSuite's stock moves now, as the two-hourly copy does",
    'src/app/api/admin/books/trial-balance/route.ts': "copies NetSuite's general ledger now, as the two-hourly copy does",
  };

  it('writes down every Books step that changes something, or says here why not', () => {
    const changes = (contains: readonly string[]) =>
      contains.some((c) => c === "requireBooks(req, 'keep')" || c === 'requireSuperAdmin(' || c === "booksAllows(auth.access, 'owner')");
    const steps = new Set(MONEY_STEPS.map((s) => s.route?.file).filter(Boolean));
    const books = Object.entries(ROUTE_GUARDS).filter(([file, g]) => file.startsWith('src/app/api/admin/books/') && changes(g.contains));
    const unwritten = books.map(([file]) => file).filter((file) => !steps.has(file) && !NOT_A_STEP[file]);
    expect(unwritten).toEqual([]);
    for (const file of Object.keys(NOT_A_STEP)) {
      expect(books.some(([f]) => f === file), `${file} no longer changes anything; take it off the list`).toBe(true);
      expect(steps.has(file), `${file} is a step now; take it off the list`).toBe(false);
    }
  });

  // Routes that wait on a switch but aren't a step of their own, and why.
  const SWITCHED_NOT_A_STEP: Record<string, string> = {
    'src/app/api/pay-vendors/checks/route.ts': "prints a payment run's checks, part of paying vendors",
    'src/app/api/estimates/push/route.ts': "pushes an estimate to NetSuite; an estimate isn't in the books",
    'src/app/api/wrap-quote/netsuite/route.ts': "sends a wrap quote to NetSuite as an estimate; an estimate isn't in the books",
  };

  it('writes down every route that waits on a switch, or says here why not', () => {
    const steps = new Set(MONEY_STEPS.map((s) => s.route?.file).filter(Boolean));
    const switched = Object.entries(ROUTE_GUARDS)
      .filter(([, g]) => g.contains.some((c) => /^(switchIsOn|readSwitch)\(/.test(c)))
      .map(([file]) => file);
    expect(switched.filter((file) => !steps.has(file) && !SWITCHED_NOT_A_STEP[file])).toEqual([]);
    for (const file of Object.keys(SWITCHED_NOT_A_STEP)) expect(switched).toContain(file);
  });

  it('says who in words', () => {
    const step = (key: string) => MONEY_STEPS.find((s) => s.key === key)!;
    expect(whoText(step('invoice'))).toBe('Anyone with Invoicing');
    expect(whoText(step('parts_mail_bill'))).toBe('Admins or Finance / AP people');
    expect(whoText(step('journal_entry'))).toBe('Anyone with Vendor Payments, the CPA or super admins');
    expect(whoText(step('rent_mortgage'))).toBe('Super admins and the bookkeeper, who also have Vendor Payments');
    expect(whoText(step('read'))).toBe('Super admins, the bookkeeper and the CPA');
    expect(whoText(step('switches'))).toBe('Super admins');
  });

  it('lets through who the guards let through', () => {
    const p = (roles: string[], features: string[] = []) => ({ roles, features: new Set(features) });
    expect(holds({ kind: 'admin' }, p(['super_admin']))).toBe(true);
    expect(holds({ kind: 'admin' }, p(['sales']))).toBe(false);
    expect(holds({ kind: 'superAdmin' }, p(['admin']))).toBe(false);
    expect(holds({ kind: 'feature', feature: 'invoicing' }, p(['sales'], ['invoicing']))).toBe(true);
    expect(holds({ kind: 'feature', feature: 'invoicing' }, p(['admin']))).toBe(false);
    expect(holds({ kind: 'roles', roles: ['finance'] }, p(['finance']))).toBe(true);
    expect(holds({ kind: 'books', need: 'keep' }, p(['bookkeeper']))).toBe(true);
    expect(holds({ kind: 'books', need: 'keep' }, p(['cpa']))).toBe(false);
    expect(holds({ kind: 'books', need: 'read' }, p(['cpa']))).toBe(true);
    expect(holds({ kind: 'books', need: 'owner' }, p(['bookkeeper']))).toBe(false);
    expect(holds({ kind: 'books', need: 'owner' }, p(['super_admin']))).toBe(true);
    expect(holds({ kind: 'books', need: 'read' }, p(['admin']))).toBe(false);
    const rent = MONEY_STEPS.find((s) => s.key === 'rent_mortgage')!;
    expect(canTake(rent, p(['bookkeeper']))).toBe(false);
    expect(canTake(rent, p(['bookkeeper'], ['vendor_payments']))).toBe(true);
    expect(canTake(rent, p(['sales'], ['vendor_payments']))).toBe(false);
    // A step held by roles is anyone's who has one of them.
    const review = MONEY_STEPS.find((s) => s.key === 'rules_review')!;
    expect(canTake(review, p(['cpa']))).toBe(true);
    expect(canTake(review, p(['admin', 'super_admin']))).toBe(true);
    expect(canTake(review, p(['bookkeeper']))).toBe(false);
  });
});

describe('what the database refuses, in its own words', () => {
  for (const r of DATABASE_RULES) {
    it(`${r.migration}: ${r.text}`, () => {
      expect(existsSync(path.join(ROOT, 'migrations', r.migration))).toBe(true);
      expect(migration(r.migration)).toContain(r.check);
    });
  }
});

describe('the jobs that run by themselves', () => {
  it("are vercel.json's books jobs, at their times", () => {
    const crons = (JSON.parse(read('vercel.json')).crons as Array<{ path: string; schedule: string }>)
      .filter((c) => c.path.startsWith('/api/cron/books-'))
      .map((c) => ({ path: c.path, schedule: c.schedule }))
      .sort((a, b) => a.path.localeCompare(b.path));
    expect(BOOKS_JOBS.map((j) => ({ path: j.path, schedule: j.schedule })).sort((a, b) => a.path.localeCompare(b.path))).toEqual(crons);
  });

  it('says when in Central time, daylight saving included', () => {
    expect(scheduleText('11 8 * * *', new Date('2026-11-03T12:00:00Z'))).toBe('Every day at 2:11 AM Central');
    expect(scheduleText('11 8 * * *', new Date('2026-07-01T12:00:00Z'))).toBe('Every day at 3:11 AM Central');
    expect(scheduleText('58 9,13 * * *', new Date('2026-11-03T12:00:00Z'))).toBe('Every day at 3:58 AM and 7:58 AM Central');
    expect(scheduleText('48 1,3,5,7,9,11,13,15,17,19,21,23 * * *', new Date('2026-11-03T12:00:00Z'))).toBe('Every two hours, at 48 past');
    expect(scheduleText('6 1,3,5,7,9,11,13,15,17,19,21,23 * * *', new Date('2026-11-03T12:00:00Z'))).toBe('Every two hours, at 06 past');
  });
});

describe("the CPA's review", () => {
  const row = (over: Partial<ReviewRow> = {}): ReviewRow => ({
    reviewedAt: '2026-11-03T15:00:00Z', reviewedByName: 'Pat CPA', reviewedAs: 'cpa',
    rules: ['invoice@1', 'payment@1'], fingerprint: 'a'.repeat(64), note: null, ...over,
  });

  it('says never before the first', () => {
    expect(reviewState(null, { rules: ['invoice@1'], fingerprint: 'b'.repeat(64) }))
      .toEqual({ state: 'never', last: null, added: [], gone: [], reworded: false });
  });

  it("says it's current while the words are as reviewed", () => {
    expect(reviewState(row(), { rules: ['invoice@1', 'payment@1'], fingerprint: 'a'.repeat(64) }).state).toBe('current');
  });

  it('names rules added and gone since, or says the words changed', () => {
    expect(reviewState(row(), { rules: ['invoice@1', 'bill@1'], fingerprint: 'c'.repeat(64) }))
      .toMatchObject({ state: 'changed', added: ['bill@1'], gone: ['payment@1'], reworded: false });
    expect(reviewState(row(), { rules: ['invoice@1', 'payment@1'], fingerprint: 'c'.repeat(64) }))
      .toMatchObject({ state: 'changed', added: [], gone: [], reworded: true });
  });

  it('takes a note as the table does', () => {
    expect(cleanNote(undefined)).toEqual({ note: null });
    expect(cleanNote('   ')).toEqual({ note: null });
    expect(cleanNote('  Read the PDF.  ')).toEqual({ note: 'Read the PDF.' });
    expect(cleanNote('x'.repeat(601))).toEqual({ error: 'A note is 600 characters at most.' });
    expect(cleanNote(5)).toEqual({ error: 'A note is words.' });
  });
});
