// Migration 505 switches Portal billing on FleetSuite's books off, a
// twenty-first books switch. This runs migration 505 in an in-memory
// Postgres (PGlite) over the switches as the earlier migrations leave them,
// and holds that it adds the piece, off, keeps the others as they were, and
// takes nothing the app doesn't name.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { SWITCH_PIECES } from './switches';

const PIECES = [
  'credit_memos', 'vendor_credits', 'card_charges', 'journal_entries', 'inventory_transfers', 'invoice_fixes', 'bill_fixes',
  'customer_vendor_details', 'item_accounts', 'estimates_in_fleetsuite', 'fleetsuite_records', 'customer_payments',
  'customer_deposits', 'bank_deposits', 'vendor_payments', 'adjustment_approvals', 'own_numbers', 'invoice_pdfs', 'stock_counts',
  'money_screens',
];

async function freshDb(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(`
    -- What migration 505 points at, as the earlier migrations leave it.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.books_switches (
      piece TEXT PRIMARY KEY CHECK (piece IN (${PIECES.map((p) => `'${p}'`).join(', ')})),
      is_on BOOLEAN NOT NULL DEFAULT false,
      changed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
      changed_at TIMESTAMPTZ
    );
  `);
  await pg.query("INSERT INTO books_switches (piece, is_on) VALUES ('credit_memos', true), ('money_screens', true)");
  const sql = readFileSync(path.resolve(__dirname, '../../../migrations/505-books-portal.sql'), 'utf8');
  await pg.exec(sql);
  await pg.exec(sql); // must be safe to re-run
  return pg;
}

describe('migration 505', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); });
  afterAll(async () => { await db.close(); });

  it("adds Portal billing on FleetSuite's books, off, and keeps every earlier piece as it was", async () => {
    expect((await db.query('SELECT piece, is_on, changed_by FROM books_switches ORDER BY piece')).rows).toEqual([
      { piece: 'credit_memos', is_on: true, changed_by: null },
      { piece: 'money_screens', is_on: true, changed_by: null },
      { piece: 'portal_books', is_on: false, changed_by: null },
    ]);
  });

  it('takes every piece the app names, and nothing else', async () => {
    expect(SWITCH_PIECES).toEqual([...PIECES, 'portal_books']);
    for (const piece of SWITCH_PIECES) {
      await db.query('INSERT INTO books_switches (piece) VALUES ($1) ON CONFLICT (piece) DO NOTHING', [piece]);
    }
    expect((await db.query('SELECT count(*)::int AS n FROM books_switches')).rows[0]).toEqual({ n: 21 });
    await expect(db.query("INSERT INTO books_switches (piece) VALUES ('portal_book')")).rejects.toThrow('books_switches_piece_check');
  });
});
