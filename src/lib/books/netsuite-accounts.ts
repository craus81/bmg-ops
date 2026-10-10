import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import type { BooksCompany } from './journal';

/**
 * FleetSuite's chart of accounts follows NetSuite's until the changeover
 * (owner decision 2026-10-10, migration 360). It runs every two hours at the
 * start of the ledger mirror cron (/api/cron/ledger-netsuite-mirror, :35 on
 * even hours), and from "Sync now" on the Books accounts page:
 *
 *   1. read every NetSuite account, which subsidiaries each one is limited
 *      to, and the subsidiaries themselves;
 *   2. link a company not yet tied to a subsidiary (1084) by name;
 *   3. work out each account's FleetSuite type and company;
 *   4. hand the list to gl_sync_netsuite_accounts, which applies it in one
 *      transaction.
 *
 * Nothing is written back to NetSuite. Only the account list is required:
 * when NetSuite won't give the subsidiary reads, accounts keep the company
 * limits they had and the result notes why.
 *
 * The heartbeat (sync_state 'books_netsuite_accounts') is deliberately not
 * in HEALTH_MONITORS: the books are hidden from everyone but the owner, and
 * a failing read would push alerts to every System Health admin. The Books
 * accounts page shows it instead.
 */

export const BOOKS_ACCOUNTS_SYNC = 'books_netsuite_accounts';

export type GlAccountType =
  | 'bank' | 'accounts_receivable' | 'other_current_asset' | 'fixed_asset' | 'other_asset'
  | 'unbilled_receivable' | 'deferred_expense'
  | 'accounts_payable' | 'credit_card' | 'other_current_liability' | 'long_term_liability'
  | 'deferred_revenue' | 'equity'
  | 'income' | 'other_income' | 'cost_of_goods_sold' | 'expense' | 'other_expense';

/** NetSuite's account type → FleetSuite's. null = not a posting account, so not synced. */
export const NETSUITE_ACCOUNT_TYPES: Record<string, GlAccountType | null> = {
  Bank: 'bank',
  AcctRec: 'accounts_receivable',
  OthCurrAsset: 'other_current_asset',
  FixedAsset: 'fixed_asset',
  OthAsset: 'other_asset',
  UnbilledRec: 'unbilled_receivable',
  DeferExpense: 'deferred_expense',
  AcctPay: 'accounts_payable',
  CredCard: 'credit_card',
  OthCurrLiab: 'other_current_liability',
  LongTermLiab: 'long_term_liability',
  DeferRevenue: 'deferred_revenue',
  Equity: 'equity',
  Income: 'income',
  OthIncome: 'other_income',
  COGS: 'cost_of_goods_sold',
  Expense: 'expense',
  OthExpense: 'other_expense',
  NonPosting: null,
  Stat: null,
};

// Ordered by id so the pages SuiteQL hands back neither skip nor repeat rows.
export const ACCOUNTS_QUERY =
  'SELECT a.id, a.acctnumber, a.acctname, a.accttype, a.parent, a.isinactive, a.issummary, a.description FROM account a ORDER BY a.id';
export const ACCOUNT_SUBSIDIARIES_QUERY =
  'SELECT m.account, m.subsidiary FROM AccountSubsidiaryMap m ORDER BY m.account, m.subsidiary';
export const SUBSIDIARIES_QUERY = 'SELECT s.id, s.name, s.isinactive FROM subsidiary s ORDER BY s.id';

export interface SyncAccount {
  netsuite_id: string;
  number: string | null;
  name: string;
  account_type: GlAccountType;
  netsuite_type: string;
  parent_netsuite_id: string | null;
  active: boolean;
  summary: boolean;
  description: string | null;
  /** Present only when NetSuite said which subsidiaries the account is limited to. */
  company?: BooksCompany | null;
  subsidiary_ids?: string[];
}

export interface CompanyRow {
  code: BooksCompany;
  name: string;
  netsuite_subsidiary_id: string | null;
}

export interface SubsidiaryLink {
  company: BooksCompany;
  subsidiary_id: string;
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const isTrue = (v: unknown): boolean => v === true || text(v).toUpperCase() === 'T';
const numericId = (v: unknown): string | null => (/^\d+$/.test(text(v)) ? text(v) : null);
const words = (s: string): string => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** Account id → the subsidiary ids it's limited to, from AccountSubsidiaryMap rows. */
export function subsidiariesByAccount(rows: Array<{ account?: unknown; subsidiary?: unknown }>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const account = numericId(row.account);
    const sub = numericId(row.subsidiary);
    if (!account || !sub) continue;
    const list = out.get(account) ?? [];
    if (!list.includes(sub)) list.push(sub);
    out.set(account, list);
  }
  return out;
}

/**
 * Which company may use an account, from the subsidiaries NetSuite limits
 * it to: one company's subsidiary alone → that company. Both companies, or
 * any subsidiary that isn't one of ours (usually the parent, which covers
 * both), or none listed → null, usable by both.
 */
export function companyFor(subsidiaryIds: string[], links: Map<string, BooksCompany>): BooksCompany | null {
  const companies = new Set<BooksCompany>();
  for (const id of subsidiaryIds) {
    const company = links.get(id);
    if (!company) return null;
    companies.add(company);
  }
  return companies.size === 1 ? [...companies][0] : null;
}

/**
 * Links for companies that have no NetSuite subsidiary yet. A company links
 * when exactly one active subsidiary not already taken has its name in the
 * subsidiary's name, or (for a code with digits, like 1084) its code as a
 * whole word.
 */
export function findSubsidiaryLinks(
  subsidiaries: Array<{ id?: unknown; name?: unknown; isinactive?: unknown }>,
  companies: CompanyRow[],
): SubsidiaryLink[] {
  const taken = new Set(companies.map((c) => text(c.netsuite_subsidiary_id)).filter(Boolean));
  const candidates = subsidiaries
    .map((s) => ({ id: numericId(s.id), name: words(text(s.name)), inactive: isTrue(s.isinactive) }))
    .filter((s): s is { id: string; name: string; inactive: boolean } => !!s.id && !s.inactive && !taken.has(s.id));
  const links: SubsidiaryLink[] = [];
  for (const company of companies) {
    if (company.netsuite_subsidiary_id) continue;
    const name = words(company.name);
    const code = /\d/.test(company.code) ? words(company.code) : null;
    const matches = candidates.filter((s) => s.name.includes(name) || (code !== null && s.name.includes(code)));
    if (matches.length === 1) links.push({ company: company.code, subsidiary_id: matches[0].id });
  }
  return links;
}

/**
 * NetSuite account rows as the sync function takes them. Non-posting and
 * statistical accounts are counted and left out; a type this code doesn't
 * know is listed so it can be added.
 */
export function mapNetSuiteAccounts(
  rows: Array<Record<string, unknown>>,
  subsidiaries: Map<string, string[]> | null,
  links: Map<string, BooksCompany>,
): { accounts: SyncAccount[]; skipped: Record<string, number>; unknownTypes: string[] } {
  const accounts: SyncAccount[] = [];
  const skipped: Record<string, number> = {};
  const unknownTypes = new Set<string>();
  for (const row of rows) {
    const id = numericId(row.id);
    if (!id) continue;
    const nsType = text(row.accttype);
    const type = NETSUITE_ACCOUNT_TYPES[nsType];
    if (type === undefined) {
      unknownTypes.add(nsType || '(blank)');
      continue;
    }
    if (type === null) {
      skipped[nsType] = (skipped[nsType] ?? 0) + 1;
      continue;
    }
    const number = text(row.acctnumber) || null;
    const account: SyncAccount = {
      netsuite_id: id,
      number,
      name: text(row.acctname) || number || `NetSuite account ${id}`,
      account_type: type,
      netsuite_type: nsType,
      parent_netsuite_id: numericId(row.parent),
      active: !isTrue(row.isinactive),
      summary: isTrue(row.issummary),
      description: text(row.description) || null,
    };
    if (subsidiaries) {
      const subs = subsidiaries.get(id) ?? [];
      account.subsidiary_ids = subs;
      account.company = companyFor(subs, links);
    }
    accounts.push(account);
  }
  return { accounts, skipped, unknownTypes: [...unknownTypes].sort() };
}

export interface BooksAccountsSyncResult {
  received?: number;
  added?: number;
  changed?: number;
  gone?: number;
  issues?: Array<{ issue: string; netsuite_id?: string; number?: string | null; name?: string }>;
  skipped?: Record<string, number>;
  unknownTypes?: string[];
  linked?: SubsidiaryLink[];
  /** What the run couldn't do, in plain words. */
  notes?: string[];
  error?: string;
}

type SuiteqlAll = (query: string) => Promise<any[]>;

const reason = (err: unknown) => String((err as any)?.message || err).slice(0, 300);

export async function syncBooksAccounts(
  service: SupabaseClient,
  deps: { query?: SuiteqlAll } = {},
): Promise<BooksAccountsSyncResult & { heartbeat: HeartbeatResult }> {
  // A background sync can wait out NetSuite's occasional transient error.
  const query = deps.query ?? ((q: string) => suiteqlQueryAll(q, 1000, { retries: 2 }));
  const startedAt = Date.now();
  const result: BooksAccountsSyncResult = {};
  const notes: string[] = [];
  try {
    const rows = await query(ACCOUNTS_QUERY);

    let subsidiaryMap: Map<string, string[]> | null = null;
    try {
      subsidiaryMap = subsidiariesByAccount(await query(ACCOUNT_SUBSIDIARIES_QUERY));
    } catch (err) {
      notes.push(`NetSuite wouldn't say which subsidiaries each account is limited to (${reason(err)}), so company limits stay as they were.`);
    }
    let subsidiaries: Array<Record<string, unknown>> = [];
    try {
      subsidiaries = await query(SUBSIDIARIES_QUERY);
    } catch (err) {
      notes.push(`NetSuite wouldn't list its subsidiaries (${reason(err)}).`);
    }

    const { data: companyRows, error: companyErr } = await service
      .from('gl_companies')
      .select('code, name, netsuite_subsidiary_id');
    if (companyErr) throw new Error(companyErr.message);
    const companies = (companyRows || []) as CompanyRow[];
    const linked = findSubsidiaryLinks(subsidiaries, companies);
    const links = new Map<string, BooksCompany>();
    for (const c of companies) if (c.netsuite_subsidiary_id) links.set(String(c.netsuite_subsidiary_id), c.code);
    for (const l of linked) links.set(l.subsidiary_id, l.company);
    for (const c of companies) {
      if (subsidiaryMap && ![...links.values()].includes(c.code)) {
        notes.push(`${c.name} isn't linked to a NetSuite subsidiary yet, so accounts limited to it are open to both companies.`);
      }
    }

    const mapped = mapNetSuiteAccounts(rows, subsidiaryMap, links);
    const { data, error } = await service.rpc('gl_sync_netsuite_accounts', {
      p: { complete: true, company_subsidiaries: linked, accounts: mapped.accounts },
    });
    if (error) throw new Error(error.message);
    Object.assign(result, data, { skipped: mapped.skipped, unknownTypes: mapped.unknownTypes, linked });
  } catch (err) {
    result.error = reason(err);
  }
  if (notes.length) result.notes = notes;
  const heartbeat = await recordHeartbeat(service, BOOKS_ACCOUNTS_SYNC, result, {
    startedAt,
    records: result.received ?? null,
  });
  return { ...result, heartbeat };
}
