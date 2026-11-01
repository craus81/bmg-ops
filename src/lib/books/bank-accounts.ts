import type { SupabaseClient } from '@supabase/supabase-js';
import { BOOKS_COMPANIES, type BooksCompany } from './journal';
import type { BankAccount } from '@/lib/bank-deposit';

/**
 * The companies and bank accounts money moves through in FleetSuite, read
 * from Books' copy of NetSuite's chart of accounts: bank deposits (Books part
 * 56, /api/invoices/bank-deposit) and payment runs (part 57, /api/pay-vendors)
 * both read them here, so a deposit and a payment are only ever made to and
 * from the same accounts.
 */

export interface BankCompany {
  code: BooksCompany;
  name: string;
  /** gl_companies.id. */
  id: string;
  /** NetSuite's id for its subsidiary. */
  subsidiaryId: string;
}

/** The companies Books has a NetSuite subsidiary for, in Books' order. */
export async function readBankCompanies(service: SupabaseClient): Promise<BankCompany[]> {
  const { data, error } = await service.from('gl_companies').select('id, code, name, netsuite_subsidiary_id').eq('active', true).order('code');
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ id: string; code: string; name: string; netsuite_subsidiary_id: string | null }>;
  return BOOKS_COMPANIES.flatMap((code) => {
    const row = rows.find((r) => r.code === code);
    return row && /^\d+$/.test(row.netsuite_subsidiary_id ?? '')
      ? [{ code, name: row.name, id: row.id, subsidiaryId: row.netsuite_subsidiary_id as string }]
      : [];
  });
}

/** The company's bank accounts, as Books' chart of accounts has them from NetSuite: active, posting, in its subsidiary. */
export async function readBankAccounts(service: SupabaseClient, company: BankCompany): Promise<BankAccount[]> {
  const { data, error } = await service.from('gl_accounts')
    .select('netsuite_account_id, number, name, company_id, netsuite_subsidiary_ids')
    .eq('account_type', 'bank').eq('active', true).eq('is_summary', false).not('netsuite_account_id', 'is', null)
    .order('number').order('netsuite_account_id').limit(500);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{
    netsuite_account_id: string; number: string | null; name: string; company_id: string | null; netsuite_subsidiary_ids: string[] | null;
  }>;
  return rows
    .filter((r) => /^\d+$/.test(r.netsuite_account_id)
      && (r.netsuite_subsidiary_ids ? r.netsuite_subsidiary_ids.includes(company.subsidiaryId) : r.company_id === company.id))
    .map((r) => ({ netsuiteId: r.netsuite_account_id, number: r.number, name: r.name }));
}

/** The company by its code, or the first when none is named; null for a code Books has no such company for. */
export const companyNamed = (companies: readonly BankCompany[], code: string | null) =>
  companies.find((c) => c.code === code) ?? (code ? null : companies[0] ?? null);
