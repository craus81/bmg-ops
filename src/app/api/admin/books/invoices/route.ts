import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { fetchAllRows } from '@/lib/fetch-all';
import { BOOKS_GL_SYNC, COPY_FROM, monthOfDate, monthsBetween } from '@/lib/books/netsuite-gl';
import { BOOKS_LISTS_SYNC } from '@/lib/books/netsuite-lists';
import { RULES, type SalesDocKind } from '@/lib/books/invoice-rule';
import { checkMonth, type ChartAccount, type InvoiceMonthData, type ItemAccountCount, type LineFactsRead, type TaxAccountCount } from '@/lib/books/invoice-check';
import { readLineFacts } from '@/lib/books/invoice-line-facts';
import { PAYMENT_RULE } from '@/lib/books/payment-rule';
import { checkPaymentMonth, type PaymentMonthData } from '@/lib/books/payment-check';
import { DEPOSIT_RULE } from '@/lib/books/deposit-rule';
import { checkDepositMonth, type DepositMonthData } from '@/lib/books/deposit-check';
import { BOOKS_DEPOSITS_SYNC } from '@/lib/books/netsuite-deposits';
import { BILL_RULE } from '@/lib/books/bill-rule';
import { checkBillMonth } from '@/lib/books/bill-check';
import { BOOKS_BILLS_SYNC } from '@/lib/books/netsuite-bills';
import { BILL_PAYMENT_RULE } from '@/lib/books/bill-payment-rule';
import { checkBillPaymentMonth, type BillPaymentMonthData } from '@/lib/books/bill-payment-check';
import { BOOKS_BILL_PAYMENTS_SYNC } from '@/lib/books/netsuite-bill-payments';
import { SPENDING_RULE } from '@/lib/books/spending-rule';
import { checkSpendingMonth } from '@/lib/books/spending-check';
import { BOOKS_SPENDING_SYNC, readSpendingMonth } from '@/lib/books/netsuite-spending';
import { JOURNAL_ENTRY_RULE } from '@/lib/books/journal-entry-rule';
import { checkJournalMonth, type JournalMonthData } from '@/lib/books/journal-entry-check';
import { BANK_RULE } from '@/lib/books/bank-rule';
import { checkBankMonth, type BankMonthData } from '@/lib/books/bank-check';
import { STOCK_RULE } from '@/lib/books/stock-rule';
import { checkStockMonth, type StockMonthData } from '@/lib/books/stock-check';
import {
  BOOKS_INVOICE_POSTING, POSTING_COMPANIES, bankDocumentBooks, bankPostingFor, billBooks, billPaymentBooks, billPostingFor, depositBooks,
  depositPostingFor, entryLines, invoiceBooks, journalEntryBooks, paymentBooks, postInvoices, postingFor, postingKey, readBillMonth, spendingBooks,
  spendingPostingFor, stockDocumentBooks, stockPostingFor, unsaidFacts,
  type BankPosting, type BillPaymentPosting, type BillPosting, type DepositPosting, type InvoicePosting, type JournalEntryPosting,
  type PaymentPosting, type SpendingPosting, type StockPosting,
} from '@/lib/books/invoice-posting';
import { OWN_COMPANY } from '@/lib/books/own-invoices';
import { ownCopyDays, ownPick, readOwnCopies, salesTaxAccount, type OwnCopies } from '@/lib/books/own-invoice-posting';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { compactSuiteqlError } from '@/lib/sales-order-sync';

export const dynamic = 'force-dynamic';
// "Post now" runs the same job as the cron, with the same budget.
export const maxDuration = 300;

const POSTING_BUDGET_MS = 240_000;

/**
 * GET /api/admin/books/invoices?company=BMG&month=2026-09&kind=invoice — one
 * company's NetSuite invoices that NetSuite booked into a month (or, when it
 * hasn't booked them, dated in it), or with `kind=credit_memo` its credit
 * memos, each with the entry FleetSuite's rule works out for it next to the
 * GL lines NetSuite posted (migrations 364, 370 and 380), and why any
 * differ. With `kind=payment` its customer payments dated in the month, each
 * checked with the payment rule (migration 374), and with `kind=deposit` its
 * customer deposits and deposit applications, checked with the deposit rule
 * (migration 382), with `kind=bill` its vendor bills and bill credits,
 * checked with the bill rule (migration 384), with `kind=bill_payment` its
 * bill payments, checked with the bill payment rule (migration 389), and
 * with `kind=spending` its checks and credit card charges and refunds,
 * checked with the spending rule (migration 391), each with how the last
 * copy of them from NetSuite went. With `kind=journal_entry` it lists the
 * journal entries NetSuite booked into the month, each one's lines from the
 * copy of NetSuite's GL next to FleetSuite's entry for it (migration 393),
 * with `kind=bank` its bank deposits, transfers and customer refunds the
 * same way (migrations 394 and 399), and with `kind=stock` its stock
 * documents, the item fulfillments, item receipts, inventory adjustments and
 * transfers, assembly builds and unbuilds and the cost lines of its invoices
 * and credit memos (migration 395), with when that copy last ran. With `summary=1` only the counts come
 * back, for checking every month in turn.
 *
 * What the copy of the invoices' lines doesn't keep (which lines are cost of
 * goods, a discount or markup set at the top, each line's own amount,
 * quantity and rate) is asked of NetSuite each time
 * (src/lib/books/invoice-line-facts.ts); when it can't be, the check goes
 * without and says so.
 *
 * For a company whose documents post (src/lib/books/invoice-posting.ts),
 * each invoice, credit memo, payment, deposit, application, bill, bill
 * credit, bill payment, check, card charge, card refund, journal entry, bank
 * deposit, transfer, customer refund or stock document also says what
 * FleetSuite's books hold for it (migrations 367, 376, 383, 386, 390, 392,
 * 393, 394, 395 and 399) and what the next posting run does about it, or
 * that it has nothing to post, and `lastRun` is how the last one went. An
 * invoice FleetSuite made also says which copy its entry was made from and
 * whether the books post FleetSuite's own copy of it, or why not (migration
 * 409, src/lib/books/own-invoice-posting.ts).
 *
 * Super admin only: the books are being built hidden, for the owner, until
 * they're ready (docs/books.md). It only reads.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const service = createServiceClient();
  const [companies, accounts, lists, posting] = await Promise.all([
    service.from('gl_companies').select('id, code, name').order('code'),
    fetchAllRows<Omit<ChartAccount, 'company'> & { company_id: string | null }>((from, to) => service
      .from('gl_accounts')
      .select('netsuite_account_id, number, name, account_type, company_id, active, is_summary')
      .order('id', { ascending: true })
      .range(from, to)),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_LISTS_SYNC).maybeSingle(),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_INVOICE_POSTING).maybeSingle(),
  ]);
  const error = companies.error || accounts.error || lists.error || posting.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const codeOf = new Map((companies.data || []).map((c) => [c.id as string, c.code as string]));
  const codes = [...codeOf.values()];
  const asked = params.get('company');
  const company = asked && codes.includes(asked) ? asked : codes.includes('BMG') ? 'BMG' : codes[0];
  if (!company) return NextResponse.json({ error: 'No companies set up' }, { status: 500 });

  // Every month from January 2025, defaulting to last month.
  const today = new Date().toISOString().slice(0, 10);
  const months = monthsBetween(COPY_FROM, monthOfDate(today)!);
  const lastCalendar = new Date();
  lastCalendar.setUTCDate(1);
  lastCalendar.setUTCMonth(lastCalendar.getUTCMonth() - 1);
  const previous = monthOfDate(lastCalendar.toISOString().slice(0, 10))!;
  const askedMonth = params.get('month');
  const month = askedMonth && /^\d{4}-\d{2}$/.test(askedMonth) && months.includes(`${askedMonth}-01`)
    ? `${askedMonth}-01`
    : months.includes(previous) ? previous : months[0];

  const askedKind = params.get('kind');
  const kind: SalesDocKind | 'payment' | 'deposit' | 'bill' | 'bill_payment' | 'spending' | 'journal_entry' | 'bank' | 'stock' =
    askedKind === 'credit_memo' || askedKind === 'payment' || askedKind === 'deposit' || askedKind === 'bill' || askedKind === 'bill_payment'
      || askedKind === 'spending' || askedKind === 'journal_entry' || askedKind === 'bank' || askedKind === 'stock'
      ? askedKind
      : 'invoice';
  const chart = accounts.data.map(({ company_id, ...a }) => ({ ...a, company: company_id ? codeOf.get(company_id) ?? null : null }));
  const page = {
    companies: (companies.data || []).map((c) => ({ code: c.code, name: c.name })),
    company,
    month,
    months,
    lastRun: posting.data ? { at: posting.data.updated_at, result: posting.data.last_result } : null,
  };

  // Whether the company's documents post, and so what its books hold for each and what the next run does.
  const posts = (POSTING_COMPANIES as readonly string[]).includes(company);

  // How the last copy of a kind of document from NetSuite went, counts and words only.
  const copyOf = (copy: { last_result: unknown; updated_at: string } | null) => {
    if (!copy) return null;
    const last = (copy.last_result ?? null) as { read?: number; partial?: boolean; notes?: string[]; error?: string } | null;
    return {
      at: copy.updated_at,
      result: {
        read: Number(last?.read) || 0,
        partial: !!last?.partial,
        ...(Array.isArray(last?.notes) ? { notes: last.notes.map(String) } : {}),
        ...(last?.error ? { error: String(last.error) } : {}),
      },
    };
  };

  if (kind === 'journal_entry') {
    // Straight from the copy of NetSuite's GL: its journal entries have no copy of their own.
    const [res, gl] = await Promise.all([
      service.rpc('gl_journal_month', { p_company: company, p_month: month }),
      service.from('sync_state').select('updated_at').eq('sync_type', BOOKS_GL_SYNC).maybeSingle(),
    ]);
    const failed = res.error || gl.error;
    if (failed) return NextResponse.json({ error: failed.message }, { status: 500 });
    const entries = ((res.data ?? {}) as Partial<JournalMonthData>).journal_entries ?? [];
    let held: Map<string, JournalEntryPosting> | null = null;
    if (posts) {
      held = new Map();
      if (entries.length) {
        const books = await service.rpc('gl_journal_postings', { p_company: company, p_source_ids: entries.map((e) => e.netsuite_id), p_lines: true });
        if (books.error) return NextResponse.json({ error: books.error.message }, { status: 500 });
        for (const p of ((books.data as any)?.journal_entries ?? []) as JournalEntryPosting[]) held.set(p.source_id, p);
      }
    }
    const check = checkJournalMonth(
      { journal_entries: entries },
      { company, chart },
      held ? (w) => journalEntryBooks(w, held!.get(w.entry.netsuite_id)) : undefined,
    );
    if (params.get('summary') === '1') return NextResponse.json({ company, month, kind, summary: check.summary });
    return NextResponse.json({
      rule: JOURNAL_ENTRY_RULE, kind, ...page, listsCopiedAt: null, glCopiedAt: gl.data?.updated_at ?? null, posts, ...check,
    });
  }

  if (kind === 'bank') {
    // Straight from the copy of NetSuite's GL, as journal entries are.
    const [res, gl] = await Promise.all([
      service.rpc('gl_bank_month', { p_company: company, p_month: month }),
      service.from('sync_state').select('updated_at').eq('sync_type', BOOKS_GL_SYNC).maybeSingle(),
    ]);
    const failed = res.error || gl.error;
    if (failed) return NextResponse.json({ error: failed.message }, { status: 500 });
    const documents = ((res.data ?? {}) as Partial<BankMonthData>).documents ?? [];
    let held: Map<string, BankPosting> | null = null;
    if (posts) {
      held = new Map();
      if (documents.length) {
        const books = await service.rpc('gl_bank_postings', { p_company: company, p_source_ids: documents.map((d) => d.netsuite_id), p_lines: true });
        if (books.error) return NextResponse.json({ error: books.error.message }, { status: 500 });
        for (const p of ((books.data as any)?.documents ?? []) as BankPosting[]) held.set(postingKey(p.source_type, p.source_id), p);
      }
    }
    const check = checkBankMonth({ documents }, { company, chart }, held ? (w) => bankDocumentBooks(w, bankPostingFor(held!, w)) : undefined);
    if (params.get('summary') === '1') return NextResponse.json({ company, month, kind, summary: check.summary });
    return NextResponse.json({
      rule: BANK_RULE, kind, ...page, listsCopiedAt: null, glCopiedAt: gl.data?.updated_at ?? null, posts, ...check,
    });
  }

  if (kind === 'stock') {
    // Straight from the copy of NetSuite's GL, as journal entries are: an invoice's or credit memo's cost lines only.
    const [res, gl] = await Promise.all([
      service.rpc('gl_stock_month', { p_company: company, p_month: month }),
      service.from('sync_state').select('updated_at').eq('sync_type', BOOKS_GL_SYNC).maybeSingle(),
    ]);
    const failed = res.error || gl.error;
    if (failed) return NextResponse.json({ error: failed.message }, { status: 500 });
    const documents = ((res.data ?? {}) as Partial<StockMonthData>).documents ?? [];
    let held: Map<string, StockPosting> | null = null;
    if (posts) {
      held = new Map();
      if (documents.length) {
        const books = await service.rpc('gl_stock_postings', { p_company: company, p_source_ids: documents.map((d) => d.netsuite_id), p_lines: true });
        if (books.error) return NextResponse.json({ error: books.error.message }, { status: 500 });
        for (const p of ((books.data as any)?.documents ?? []) as StockPosting[]) held.set(postingKey(p.source_type, p.source_id), p);
      }
    }
    const check = checkStockMonth({ documents }, { company, chart }, held ? (w) => stockDocumentBooks(w, stockPostingFor(held!, w)) : undefined);
    if (params.get('summary') === '1') return NextResponse.json({ company, month, kind, summary: check.summary });
    return NextResponse.json({
      rule: STOCK_RULE, kind, ...page, listsCopiedAt: null, glCopiedAt: gl.data?.updated_at ?? null, posts, ...check,
    });
  }

  if (kind === 'spending') {
    const [read, copy] = await Promise.all([
      readSpendingMonth(service, company, month).then((data) => ({ data, error: null }), (err: Error) => ({ data: null, error: err })),
      service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_SPENDING_SYNC).maybeSingle(),
    ]);
    const failed = read.error || copy.error;
    if (failed) return NextResponse.json({ error: failed.message }, { status: 500 });
    const data = read.data!;
    let held: Map<string, SpendingPosting> | null = null;
    if (posts) {
      const mine = data.documents.filter((d) => d.companies.includes(company)).map((d) => d.netsuite_id);
      held = new Map();
      if (mine.length) {
        const books = await service.rpc('gl_spending_postings', { p_company: company, p_source_ids: mine, p_lines: true });
        if (books.error) return NextResponse.json({ error: books.error.message }, { status: 500 });
        for (const p of ((books.data as any)?.documents ?? []) as SpendingPosting[]) held.set(postingKey(p.source_type, p.source_id), p);
      }
    }
    const check = checkSpendingMonth(data, { company, chart }, held ? (w) => spendingBooks(w, spendingPostingFor(held!, w)) : undefined);
    if (params.get('summary') === '1') return NextResponse.json({ company, month, kind, summary: check.summary });
    return NextResponse.json({
      rule: SPENDING_RULE, kind, ...page, listsCopiedAt: lists.data?.updated_at ?? null, posts, copy: copyOf(copy.data), ...check,
    });
  }

  if (kind === 'bill_payment') {
    const [res, copy] = await Promise.all([
      service.rpc('gl_bill_payment_month', { p_company: company, p_month: month }),
      service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_BILL_PAYMENTS_SYNC).maybeSingle(),
    ]);
    const failed = res.error || copy.error;
    if (failed) return NextResponse.json({ error: failed.message }, { status: 500 });
    const data = (res.data ?? {}) as Partial<BillPaymentMonthData>;
    const payments = data.payments ?? [];
    let held: Map<string, BillPaymentPosting> | null = null;
    if (posts) {
      const mine = payments.filter((p) => p.companies.includes(company)).map((p) => p.netsuite_id);
      held = new Map();
      if (mine.length) {
        const books = await service.rpc('gl_bill_payment_postings', { p_company: company, p_source_ids: mine, p_lines: true });
        if (books.error) return NextResponse.json({ error: books.error.message }, { status: 500 });
        for (const p of ((books.data as any)?.payments ?? []) as BillPaymentPosting[]) held.set(p.source_id, p);
      }
    }
    const check = checkBillPaymentMonth(
      { payments, not_copied: data.not_copied ?? [] },
      { company, chart },
      held ? (w) => billPaymentBooks(w, held!.get(w.payment.netsuite_id)) : undefined,
    );
    if (params.get('summary') === '1') return NextResponse.json({ company, month, kind, summary: check.summary });
    return NextResponse.json({
      rule: BILL_PAYMENT_RULE, kind, ...page, listsCopiedAt: lists.data?.updated_at ?? null, posts, copy: copyOf(copy.data), ...check,
    });
  }

  if (kind === 'bill') {
    // The month as the posting job reads it, so what this shows is what it posts.
    const [read, copy] = await Promise.all([
      readBillMonth(service, company, month).then((data) => ({ data, error: null }), (err: Error) => ({ data: null, error: err })),
      service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_BILLS_SYNC).maybeSingle(),
    ]);
    const failed = read.error || copy.error;
    if (failed) return NextResponse.json({ error: failed.message }, { status: 500 });
    const data = read.data!;
    let held: Map<string, BillPosting> | null = null;
    if (posts) {
      const mine = data.bills.filter((b) => b.companies.includes(company)).map((b) => b.netsuite_id);
      held = new Map();
      if (mine.length) {
        const books = await service.rpc('gl_bill_postings', { p_company: company, p_source_ids: mine, p_lines: true });
        if (books.error) return NextResponse.json({ error: books.error.message }, { status: 500 });
        for (const p of ((books.data as any)?.bills ?? []) as BillPosting[]) held.set(postingKey(p.source_type, p.source_id), p);
      }
    }
    const check = checkBillMonth(data, { company, chart }, held ? (w) => billBooks(w, billPostingFor(held!, w)) : undefined);
    if (params.get('summary') === '1') return NextResponse.json({ company, month, kind, summary: check.summary });
    return NextResponse.json({
      rule: BILL_RULE, kind, ...page, listsCopiedAt: lists.data?.updated_at ?? null, posts, copy: copyOf(copy.data), ...check,
    });
  }

  if (kind === 'deposit') {
    const [res, copy] = await Promise.all([
      service.rpc('gl_deposit_month', { p_company: company, p_month: month }),
      service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_DEPOSITS_SYNC).maybeSingle(),
    ]);
    const failed = res.error || copy.error;
    if (failed) return NextResponse.json({ error: failed.message }, { status: 500 });
    const data = (res.data ?? {}) as Partial<DepositMonthData>;
    const deposits = data.deposits ?? [];
    let held: Map<string, DepositPosting> | null = null;
    if (posts) {
      const mine = deposits.filter((d) => d.companies.includes(company)).map((d) => d.netsuite_id);
      held = new Map();
      if (mine.length) {
        const books = await service.rpc('gl_deposit_postings', { p_company: company, p_source_ids: mine, p_lines: true });
        if (books.error) return NextResponse.json({ error: books.error.message }, { status: 500 });
        for (const p of ((books.data as any)?.deposits ?? []) as DepositPosting[]) held.set(postingKey(p.source_type, p.source_id), p);
      }
    }
    const check = checkDepositMonth(
      { deposits, accounts: data.accounts ?? [], not_copied: data.not_copied ?? [] },
      { company, chart },
      held ? (w) => depositBooks(w, depositPostingFor(held!, w)) : undefined,
    );
    if (params.get('summary') === '1') return NextResponse.json({ company, month, kind, summary: check.summary });
    return NextResponse.json({ rule: DEPOSIT_RULE, kind, ...page, listsCopiedAt: null, posts, copy: copyOf(copy.data), ...check });
  }

  if (kind === 'payment') {
    const paid = await service.rpc('gl_payment_month', { p_company: company, p_month: month });
    if (paid.error) return NextResponse.json({ error: paid.error.message }, { status: 500 });
    const payments = ((paid.data ?? {}) as Partial<PaymentMonthData>).payments ?? [];
    let held: Map<string, PaymentPosting> | null = null;
    if (posts) {
      const mine = payments.filter((p) => p.companies.includes(company)).map((p) => p.netsuite_id);
      held = new Map();
      if (mine.length) {
        const res = await service.rpc('gl_payment_postings', { p_company: company, p_source_ids: mine, p_lines: true });
        if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
        for (const p of ((res.data as any)?.payments ?? []) as PaymentPosting[]) held.set(p.source_id, p);
      }
    }
    const check = checkPaymentMonth({ payments }, { company, chart }, held ? (w) => paymentBooks(w, held!.get(w.payment.netsuite_id)) : undefined);
    if (params.get('summary') === '1') return NextResponse.json({ company, month, kind, summary: check.summary });
    return NextResponse.json({ rule: PAYMENT_RULE, kind, ...page, listsCopiedAt: null, posts, ...check });
  }

  const res = await service.rpc('gl_invoice_month', { p_company: company, p_month: month });
  if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
  const data = (res.data ?? {}) as Partial<InvoiceMonthData>;

  const invoices = (data.invoices ?? []).filter((i) => i.doc_type === kind);
  let facts: LineFactsRead | { error: string } | null = null;
  if (invoices.length) {
    try {
      facts = await readLineFacts((q) => suiteqlQueryAll(q, 1000, { retries: 1 }), invoices.map((i) => i.netsuite_id));
    } catch (err) {
      facts = { error: compactSuiteqlError(err) };
    }
  }

  // What the next run does about the company's invoices: nothing in a month NetSuite couldn't say enough about.
  const decides = !!facts && 'lines' in facts && unsaidFacts(facts).length === 0;
  let postings: Map<string, InvoicePosting> | null = null;
  if (posts) {
    const mine = invoices.filter((i) => i.companies.includes(company)).map((i) => i.netsuite_id);
    postings = new Map();
    if (mine.length) {
      const held = await service.rpc('gl_invoice_postings', { p_company: company, p_source_ids: mine, p_lines: true });
      if (held.error) return NextResponse.json({ error: held.error.message }, { status: 500 });
      for (const p of ((held.data as any)?.invoices ?? []) as InvoicePosting[]) postings.set(postingKey(p.source_type, p.source_id), p);
    }
  }

  const lastLists = (lists.data?.last_result ?? null) as { taxAccounts?: TaxAccountCount[]; itemAccounts?: ItemAccountCount[] } | null;
  const taxAccounts = Array.isArray(lastLists?.taxAccounts) ? lastLists.taxAccounts : null;

  // FleetSuite's own copies of the month's invoices, as the posting run reads them, so what this shows is what it posts.
  let copies: OwnCopies = new Map();
  const days = postings && kind === 'invoice' && company === OWN_COMPANY ? ownCopyDays(invoices) : null;
  if (days) {
    try {
      copies = await readOwnCopies(service, days.from, days.to);
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
  }
  const salesTax = salesTaxAccount(taxAccounts, chart, company);

  const check = checkMonth(
    { invoices, items: data.items ?? [] },
    {
      company,
      kind,
      chart,
      taxAccounts,
      itemAccounts: Array.isArray(lastLists?.itemAccounts) ? lastLists.itemAccounts : null,
      facts,
    },
    postings
      ? (w, month) => invoiceBooks(w, postingFor(postings!, w), decides,
        ownPick(w, entryLines(w), copies.get(w.invoice.netsuite_id), { company, accounts: month.accounts, names: month.names, salesTax }))
      : undefined,
  );

  if (params.get('summary') === '1') return NextResponse.json({ company, month, kind, summary: check.summary });
  return NextResponse.json({ rule: RULES[kind], kind, ...page, listsCopiedAt: lists.data?.updated_at ?? null, posts, ...check });
}

/**
 * POST /api/admin/books/invoices — post invoices, credit memos, payments,
 * deposits, bills, bill payments, checks, card charges, journal entries, bank
 * deposits, transfers, customer refunds and stock documents to FleetSuite's
 * books now rather than wait for the two-hourly run. Same job, same record
 * of how it went; the response says only how the run went, the page reloads
 * the rest.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const result = await postInvoices(createServiceClient(), { deadline: Date.now() + POSTING_BUDGET_MS });
  return NextResponse.json({
    posting: result.error ? 'failed' : result.skipped ? 'skipped' : result.partial ? 'partial' : 'ok',
    ...(result.skipped ? { skipped: result.skipped } : {}),
  });
}
