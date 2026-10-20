import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { join } from 'path';
import { worksheetCopyRow, worksheetsToCopy, remapWorksheetIds } from './estimate-copy-worksheets';

describe('worksheetCopyRow', () => {
  it('keeps the proof, films and prices and starts a fresh draft on the copy', () => {
    const row = worksheetCopyRow({
      id: 'w1', quote_number: 'WQ-2610-005', estimate_id: 'e1', status: 'sent', sent_at: 'x', created_by: 'u0',
      photo_proofs: [{ path: 'p.jpg', diagram_path: 'quote-diagrams/WQ-1-1.jpg', boxes: [] }], diagram_path: 'quote-diagrams/WQ-1.png',
      measurements: [{ substrate: { id: 's1' } }], pricing_overrides: { discount_pct: 5 }, estimate_attach: { diagram: true },
      materials_total: 100, labor_total: 50, total: 150,
      approval_token: 't', approval_relink_count: 2, customer_approved_ip: '1.2.3.4', netsuite_estimate_id: '9',
      signed_document_hash: 'h', last_followup_at: 'x', expiry_warned_for: 'x',
    }, 'e2', 'u1');
    expect(row).toEqual({
      photo_proofs: [{ path: 'p.jpg', diagram_path: 'quote-diagrams/WQ-1-1.jpg', boxes: [] }], diagram_path: 'quote-diagrams/WQ-1.png',
      measurements: [{ substrate: { id: 's1' } }], pricing_overrides: { discount_pct: 5 }, estimate_attach: { diagram: true },
      materials_total: 100, labor_total: 50, total: 150,
      estimate_id: 'e2', status: 'draft', created_by: 'u1',
    });
  });
});

describe('worksheetsToCopy', () => {
  const ws = [{ id: 'own', estimate_id: 'src' }, { id: 'sib', estimate_id: 'other' }];
  it('copies the source\'s own worksheets, and a fleet sibling\'s when the copy leaves the group', () => {
    expect(worksheetsToCopy('src', ws, ['own', 'sib'], false)).toEqual(['own', 'sib']);
    expect(worksheetsToCopy('src', ws, ['own', 'sib'], true)).toEqual(['own']);
  });
  it('copies a pinned worksheet with no lines yet', () => {
    expect(worksheetsToCopy('src', ws, [], false)).toEqual(['own']);
  });
});

describe('remapWorksheetIds', () => {
  it('points lines at the copy\'s worksheets and leaves the rest', () => {
    const lines = [{ wrap_quote_id: 'a', n: 1 }, { wrap_quote_id: null, n: 2 }, { wrap_quote_id: 'b', n: 3 }];
    expect(remapWorksheetIds(lines, { a: 'a2' })).toEqual([{ wrap_quote_id: 'a2', n: 1 }, { wrap_quote_id: null, n: 2 }, { wrap_quote_id: 'b', n: 3 }]);
    expect(remapWorksheetIds(lines, undefined)).toBe(lines);
  });
});

/**
 * Migration 419 on a real Postgres: an open duplicate gets its own worksheet
 * and its lines move to it; fleet copies, locked estimates and the original
 * are untouched; a re-run does nothing.
 */
it('migration 419 copies worksheets and art proofs onto old duplicates, once', async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE estimates (id uuid primary key, estimate_number text, fleet_group_id uuid, customer_approved boolean, status text, netsuite_so_id text, supersedes_estimate_id uuid);
    CREATE TABLE wrap_quotes (id uuid primary key default gen_random_uuid(), quote_number text not null unique,
      estimate_id uuid, status text not null default 'draft', photo_proofs jsonb not null default '[]', diagram_path text,
      total numeric, approval_token uuid, approval_relink_count int not null default 0, netsuite_estimate_id text,
      created_by uuid, created_at timestamptz default now(), updated_at timestamptz default now());
    CREATE TABLE estimate_line_items (id serial primary key, estimate_id uuid, wrap_quote_id uuid);
    -- Production's migration-045 trigger, on a table with no updated_at.
    CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$;
    CREATE TRIGGER update_estimate_line_items_updated_at BEFORE UPDATE ON estimate_line_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
    CREATE TABLE graphics_jobs (id uuid primary key, estimate_id uuid, fleet_group_id uuid, estimate_attach jsonb, created_at timestamptz default now());
    CREATE TABLE audit_log (id serial primary key, table_name text, record_id text, action text, detail jsonb);
    CREATE SEQUENCE wq_seq;
    CREATE FUNCTION public.next_job_number(p text) RETURNS text LANGUAGE sql AS $$ select p || '-NEW-' || nextval('wq_seq') $$;
    INSERT INTO estimates (id, estimate_number, fleet_group_id, customer_approved, status, netsuite_so_id, supersedes_estimate_id) VALUES
      ('00000000-0000-0000-0000-000000000001', 'EST-1', null, false, 'sent', null, null),
      ('00000000-0000-0000-0000-000000000002', 'EST-2', null, false, 'draft', null, null),
      ('00000000-0000-0000-0000-000000000003', 'EST-3', null, true, 'accepted', null, null),
      ('00000000-0000-0000-0000-000000000004', 'EST-4', null, false, 'draft', null, '00000000-0000-0000-0000-000000000001'),
      ('00000000-0000-0000-0000-00000000000a', 'EST-A', '00000000-0000-0000-0000-0000000000f1', false, 'draft', null, null),
      ('00000000-0000-0000-0000-00000000000b', 'EST-B', '00000000-0000-0000-0000-0000000000f1', false, 'draft', null, null);
    INSERT INTO graphics_jobs (id, estimate_id, estimate_attach) VALUES
      ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000001', '{"file_ids":["f1","f2"]}'),
      ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-000000000001', '{"file_ids":[]}');
    INSERT INTO audit_log (table_name, record_id, action, detail) VALUES
      ('estimates', '00000000-0000-0000-0000-000000000002', 'estimate_duplicated', '{"source_estimate_id":"00000000-0000-0000-0000-000000000001"}'),
      ('estimates', '00000000-0000-0000-0000-000000000003', 'estimate_duplicated', '{"source_estimate_id":"00000000-0000-0000-0000-000000000001"}');
    INSERT INTO wrap_quotes (id, quote_number, estimate_id, status, photo_proofs, diagram_path, total, approval_token, approval_relink_count, netsuite_estimate_id) VALUES
      ('00000000-0000-0000-0000-0000000000a1', 'WQ-1', '00000000-0000-0000-0000-000000000001', 'sent', '[{"diagram_path":"quote-diagrams/WQ-1-1.jpg"}]', 'quote-diagrams/WQ-1-1.jpg', 150, gen_random_uuid(), 3, '77'),
      ('00000000-0000-0000-0000-0000000000a2', 'WQ-2', '00000000-0000-0000-0000-00000000000a', 'draft', '[]', null, 10, null, 0, null);
    INSERT INTO estimate_line_items (estimate_id, wrap_quote_id) VALUES
      ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1'),
      ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1'),
      ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1'),
      ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000a1'),
      ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000a2');
  `);
  const sql = readFileSync(join(__dirname, '../../migrations/419-duplicate-estimate-proofs.sql'), 'utf8');
  await db.exec(sql);
  await db.exec(sql);

  const ws = await db.query<any>(`select quote_number, estimate_id, status, diagram_path, total::int as total, approval_token, approval_relink_count, netsuite_estimate_id
    from wrap_quotes order by quote_number`);
  expect(ws.rows).toEqual([
    { quote_number: 'WQ-1', estimate_id: '00000000-0000-0000-0000-000000000001', status: 'sent', diagram_path: 'quote-diagrams/WQ-1-1.jpg', total: 150, approval_token: expect.any(String), approval_relink_count: 3, netsuite_estimate_id: '77' },
    { quote_number: 'WQ-2', estimate_id: '00000000-0000-0000-0000-00000000000a', status: 'draft', diagram_path: null, total: 10, approval_token: null, approval_relink_count: 0, netsuite_estimate_id: null },
    { quote_number: 'WQ-NEW-1', estimate_id: '00000000-0000-0000-0000-000000000002', status: 'draft', diagram_path: 'quote-diagrams/WQ-1-1.jpg', total: 150, approval_token: null, approval_relink_count: 0, netsuite_estimate_id: null },
  ]);
  const lines = await db.query<any>(`select li.estimate_id, w.quote_number from estimate_line_items li join wrap_quotes w on w.id = li.wrap_quote_id order by li.id`);
  expect(lines.rows.map((r: any) => r.quote_number)).toEqual(['WQ-1', 'WQ-NEW-1', 'WQ-NEW-1', 'WQ-1', 'WQ-2']);

  // Art proof: the open duplicate and the old revision show the original
  // job's chosen files; the accepted copy, the original and fleet copies don't.
  const proofs = await db.query<any>(`select estimate_number, copied_graphics_proofs from estimates order by estimate_number`);
  const shown = [{ job_id: '00000000-0000-0000-0000-0000000000c1', file_ids: ['f1', 'f2'], from_estimate: 'EST-1' }];
  expect(proofs.rows).toEqual([
    { estimate_number: 'EST-1', copied_graphics_proofs: null },
    { estimate_number: 'EST-2', copied_graphics_proofs: shown },
    { estimate_number: 'EST-3', copied_graphics_proofs: null },
    { estimate_number: 'EST-4', copied_graphics_proofs: shown },
    { estimate_number: 'EST-A', copied_graphics_proofs: null },
    { estimate_number: 'EST-B', copied_graphics_proofs: null },
  ]);
  const jobs = await db.query<any>(`select estimate_id from graphics_jobs order by id`);
  expect(jobs.rows.every((j: any) => j.estimate_id === '00000000-0000-0000-0000-000000000001')).toBe(true);
});
