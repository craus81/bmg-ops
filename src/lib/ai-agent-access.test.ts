import { describe, it, expect } from 'vitest';
import {
  rolesOf, canQueryNetSuite, canSeeFinancials, touchesFinancialData, stripFinancialGuidance,
} from './ai-agent-access';

describe('rolesOf', () => {
  it('prefers the roles array', () => {
    expect(rolesOf({ roles: ['sales', 'admin'], role: 'installer' })).toEqual(['sales', 'admin']);
  });
  it('falls back to the single role', () => {
    expect(rolesOf({ role: 'installer' })).toEqual(['installer']);
  });
  it('is empty for a null / role-less profile', () => {
    expect(rolesOf(null)).toEqual([]);
    expect(rolesOf({})).toEqual([]);
    expect(rolesOf({ roles: [] , role: null })).toEqual([]);
  });
});

describe('canQueryNetSuite', () => {
  it('admits office staff', () => {
    for (const r of ['admin', 'super_admin', 'executive', 'sales', 'graphics_production', 'finance']) {
      expect(canQueryNetSuite([r])).toBe(true);
    }
  });
  it('rejects external and field roles', () => {
    for (const r of ['installer', 'field_tech', 'shop_tech', 'customer']) {
      expect(canQueryNetSuite([r])).toBe(false);
    }
    expect(canQueryNetSuite([])).toBe(false);
  });
});

describe('canSeeFinancials', () => {
  it('admits only super_admin and executive', () => {
    expect(canSeeFinancials(['super_admin'])).toBe(true);
    expect(canSeeFinancials(['executive'])).toBe(true);
    expect(canSeeFinancials(['sales', 'executive'])).toBe(true);
  });
  it('rejects everyone else — a plain admin can NOT see financials', () => {
    // This is the exact leak: a regular admin pulling GL balances.
    for (const r of ['admin', 'sales', 'graphics_production', 'finance', 'shop_tech', 'installer']) {
      expect(canSeeFinancials([r])).toBe(false);
    }
  });
});

describe('touchesFinancialData — NetSuite', () => {
  const blocked = [
    ['GL bank balances', 'SELECT a.acctnumber, a.balance FROM account a'],
    ['GL detail', 'SELECT tal.debit, tal.credit FROM transactionaccountingline tal'],
    ['AR aging', "SELECT SUM(t.foreignamountunpaid) FROM transaction t WHERE t.type = 'CustInvc'"],
    ['customer AR balance', 'SELECT c.companyname, c.balance FROM customer c'],
    ['overdue balance', 'SELECT c.overduebalance FROM customer c'],
    ['credit limit', 'SELECT c.creditlimit FROM customer c'],
    ['vendor bills', "SELECT t.tranid FROM transaction t WHERE t.type = 'VendBill'"],
    ['journal entries', "SELECT t.tranid FROM transaction t WHERE t.type = 'Journal'"],
  ] as const;
  for (const [label, sql] of blocked) {
    it(`blocks: ${label}`, () => expect(touchesFinancialData('netsuite', sql)).toBe(true));
  }

  const allowed = [
    ['sales-order revenue', "SELECT SUM(t.foreigntotal) FROM transaction t WHERE t.type = 'SalesOrd'"],
    ['inventory on hand', 'SELECT i.itemid, i.quantityavailable FROM item i'],
    ['customer contact lookup', "SELECT c.companyname, c.email, c.phone FROM customer c WHERE UPPER(c.companyname) LIKE '%ACME%'"],
    ['open sales orders', "SELECT t.tranid, t.trandate FROM transaction t WHERE t.type = 'SalesOrd'"],
  ] as const;
  for (const [label, sql] of allowed) {
    it(`allows: ${label}`, () => expect(touchesFinancialData('netsuite', sql)).toBe(false));
  }
});

describe('touchesFinancialData — Supabase', () => {
  it('blocks pay / payout / audit tables', () => {
    expect(touchesFinancialData('supabase', 'SELECT * FROM payouts')).toBe(true);
    expect(touchesFinancialData('supabase', 'SELECT rate FROM pay_rates')).toBe(true);
    expect(touchesFinancialData('supabase', 'SELECT * FROM pay_splits')).toBe(true);
    expect(touchesFinancialData('supabase', 'SELECT * FROM audit_log ORDER BY created_at DESC')).toBe(true);
  });
  it('allows operational tables', () => {
    expect(touchesFinancialData('supabase', 'SELECT job_number, status FROM graphics_jobs')).toBe(false);
    expect(touchesFinancialData('supabase', 'SELECT estimate_number, grand_total FROM estimates')).toBe(false);
    expect(touchesFinancialData('supabase', 'SELECT name, panel_data FROM vehicle_templates')).toBe(false);
  });
});

describe('touchesFinancialData — misc', () => {
  it('is false for empty / undefined sql', () => {
    expect(touchesFinancialData('netsuite', undefined)).toBe(false);
    expect(touchesFinancialData('supabase', '')).toBe(false);
  });
  it('never flags non-SQL sources (knowledge, vehicle_search, action)', () => {
    expect(touchesFinancialData('knowledge', 'payouts balance account')).toBe(false);
    expect(touchesFinancialData('action', 'anything')).toBe(false);
  });
});

describe('stripFinancialGuidance', () => {
  it('removes the COMMON NETSUITE PATTERNS block, keeping surrounding text', () => {
    const prompt = 'INTRO\n\nCOMMON NETSUITE PATTERNS:\n- AR: secret\n- AP: secret\n\nANSWER FORMAT:\n- Be concise';
    const out = stripFinancialGuidance(prompt);
    expect(out).not.toContain('AR: secret');
    expect(out).not.toContain('COMMON NETSUITE PATTERNS');
    expect(out).toContain('INTRO');
    expect(out).toContain('ANSWER FORMAT:');
  });
  it('is a no-op when the anchor headers are absent', () => {
    const prompt = 'no financial section here';
    expect(stripFinancialGuidance(prompt)).toBe(prompt);
  });
});
