// Migration 483 adds the bookkeeper and CPA roles, which open FleetSuite's own books, and lets only a super admin
// give them out (or super_admin itself). This runs it after migration 233, whose profile guard it replaces, in an
// in-memory Postgres (PGlite), signing in as each person the way the browser's client does. Made-up people.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const OWNER = 'a0000000-0000-4000-8000-000000000001';
const ADMIN = 'a0000000-0000-4000-8000-000000000002';
const SALES = 'a0000000-0000-4000-8000-000000000003';
const NEWCOMER = 'a0000000-0000-4000-8000-000000000004';
const PERSON = 'a0000000-0000-4000-8000-000000000005';
const ANOTHER = 'a0000000-0000-4000-8000-000000000006';
const COMPANY = 'c0000000-0000-4000-8000-000000000001';
const migration = (file: string) => readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');

async function freshDb(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    -- Who is signed in, the way Supabase reads it from the request.
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
    CREATE TABLE public.profiles (
      id UUID PRIMARY KEY, full_name TEXT, role TEXT NOT NULL DEFAULT 'installer', roles TEXT[] DEFAULT '{}',
      status TEXT DEFAULT 'pending', deactivated BOOLEAN DEFAULT false, deactivated_at TIMESTAMPTZ, deactivated_by UUID,
      company_id UUID, customer_netsuite_id TEXT, is_field_installer BOOLEAN DEFAULT false, email_signature TEXT
    );
    -- Migration 045's.
    CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] AS $$
      SELECT COALESCE(NULLIF(roles, '{}'), ARRAY[role]) FROM public.profiles WHERE id = auth.uid()
    $$ LANGUAGE sql STABLE SECURITY DEFINER;
    CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT 'admin' = ANY (public.get_my_roles()) $$;
    INSERT INTO public.profiles (id, full_name, role, roles, status) VALUES
      ('${OWNER}', 'Sample Owner', 'admin', ARRAY['admin', 'super_admin'], 'approved'),
      ('${ADMIN}', 'Sample Admin', 'admin', ARRAY['admin'], 'approved'),
      ('${SALES}', 'Sample Rep', 'sales', ARRAY['sales'], 'approved'),
      ('${PERSON}', 'Sample Person', 'finance', ARRAY['finance'], 'approved');
  `);
  await pg.exec(migration('233-profiles-privilege-lockdown.sql'));
  await pg.exec(migration('483-books-bookkeeper-cpa-roles.sql'));
  await pg.exec(migration('483-books-bookkeeper-cpa-roles.sql')); // must be safe to re-run
  return pg;
}

describe('migration 483', () => {
  let pg: PGlite;
  const as = (who: string | null) => pg.query(`SELECT set_config('test.uid', $1, false)`, [who ?? '']);
  const rolesOf = async (id: string) =>
    (await pg.query<{ role: string; roles: string[] }>('SELECT role, roles FROM profiles WHERE id = $1', [id])).rows[0];

  beforeAll(async () => { pg = await freshDb(); }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it('lets the scalar role be bookkeeper or cpa, and nothing it does not know', async () => {
    await as(null);
    await pg.query(`INSERT INTO profiles (id, role, roles) VALUES ($1, 'cpa', ARRAY['cpa'])`, [ANOTHER]);
    await pg.query(`UPDATE profiles SET role = 'bookkeeper', roles = ARRAY['bookkeeper'] WHERE id = $1`, [ANOTHER]);
    expect(await rolesOf(ANOTHER)).toEqual({ role: 'bookkeeper', roles: ['bookkeeper'] });
    await expect(pg.query(`UPDATE profiles SET role = 'accountant' WHERE id = $1`, [ANOTHER])).rejects.toThrow(/profiles_role_check/);
    const checks = (await pg.query<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.profiles'::regclass AND contype = 'c'`)).rows;
    expect(checks).toHaveLength(1);
    for (const role of ['executive', 'finance', 'production', 'bookkeeper', 'cpa']) expect(checks[0].def).toContain(`'${role}'`);
    await pg.query('DELETE FROM profiles WHERE id = $1', [ANOTHER]);
  });

  it("keeps a signed-in person from giving themselves a books role", async () => {
    await as(SALES);
    await expect(pg.query(`UPDATE profiles SET roles = ARRAY['sales', 'bookkeeper'] WHERE id = $1`, [SALES]))
      .rejects.toThrow('permission denied: profiles.roles is not self-editable');
    await expect(pg.query(`UPDATE profiles SET role = 'cpa' WHERE id = $1`, [SALES]))
      .rejects.toThrow('permission denied: profiles.role is not self-editable');
    // What they may change is still theirs to change.
    await pg.query(`UPDATE profiles SET email_signature = 'Sample' WHERE id = $1`, [SALES]);

    // A profile someone makes for themselves can't start with one either.
    await as(NEWCOMER);
    await expect(pg.query(`INSERT INTO profiles (id, role, roles) VALUES ($1, 'installer', ARRAY['cpa'])`, [NEWCOMER]))
      .rejects.toThrow('permission denied: profiles.roles may not be self-assigned a privileged role');
    await expect(pg.query(`INSERT INTO profiles (id, role, roles) VALUES ($1, 'bookkeeper', ARRAY['installer'])`, [NEWCOMER]))
      .rejects.toThrow('permission denied: profiles.role may not be self-assigned to bookkeeper');
    await pg.query(`INSERT INTO profiles (id, role, roles) VALUES ($1, 'installer', ARRAY['installer'])`, [NEWCOMER]);
    expect(await rolesOf(NEWCOMER)).toEqual({ role: 'installer', roles: ['installer'] });
  });

  it('lets only a super admin give out the bookkeeper, CPA and super admin roles', async () => {
    await as(ADMIN);
    await expect(pg.query(`UPDATE profiles SET roles = ARRAY['finance', 'bookkeeper'] WHERE id = $1`, [PERSON]))
      .rejects.toThrow('permission denied: only a super admin can give the bookkeeper role');
    await expect(pg.query(`UPDATE profiles SET role = 'cpa', roles = ARRAY['cpa'] WHERE id = $1`, [PERSON]))
      .rejects.toThrow('permission denied: only a super admin can give the cpa role');
    // Either column alone is enough to be refused.
    await expect(pg.query(`UPDATE profiles SET role = 'cpa' WHERE id = $1`, [PERSON]))
      .rejects.toThrow('permission denied: only a super admin can give the cpa role');
    await expect(pg.query(`UPDATE profiles SET roles = ARRAY['admin', 'super_admin'] WHERE id = $1`, [ADMIN]))
      .rejects.toThrow('permission denied: only a super admin can give the super_admin role');
    await expect(pg.query(`INSERT INTO profiles (id, role, roles) VALUES ($1, 'installer', ARRAY['cpa'])`, [ANOTHER]))
      .rejects.toThrow('permission denied: only a super admin can give the cpa role');
    expect(await rolesOf(PERSON)).toEqual({ role: 'finance', roles: ['finance'] });

    // Every other role is still an admin's to give.
    await pg.query(`UPDATE profiles SET roles = ARRAY['finance', 'sales'] WHERE id = $1`, [PERSON]);
    expect(await rolesOf(PERSON)).toEqual({ role: 'finance', roles: ['finance', 'sales'] });

    await as(OWNER);
    await pg.query(`UPDATE profiles SET roles = ARRAY['finance', 'bookkeeper'] WHERE id = $1`, [PERSON]);
    await pg.query(`INSERT INTO profiles (id, role, roles, status) VALUES ($1, 'cpa', ARRAY['cpa'], 'approved')`, [ANOTHER]);
    expect(await rolesOf(PERSON)).toEqual({ role: 'finance', roles: ['finance', 'bookkeeper'] });
    expect(await rolesOf(ANOTHER)).toEqual({ role: 'cpa', roles: ['cpa'] });
  });

  it('lets an admin still change the rest of a profile that has one, and take it away', async () => {
    await as(ADMIN);
    await pg.query(`UPDATE profiles SET company_id = $2 WHERE id = $1`, [ANOTHER, COMPANY]);
    await pg.query(`UPDATE profiles SET roles = ARRAY['finance', 'bookkeeper', 'sales'] WHERE id = $1`, [PERSON]);
    expect(await rolesOf(PERSON)).toEqual({ role: 'finance', roles: ['finance', 'bookkeeper', 'sales'] });
    await pg.query(`UPDATE profiles SET roles = ARRAY['finance'] WHERE id = $1`, [PERSON]);
    await pg.query(`UPDATE profiles SET role = 'installer', roles = ARRAY['installer'] WHERE id = $1`, [ANOTHER]);
    expect(await rolesOf(PERSON)).toEqual({ role: 'finance', roles: ['finance'] });
    expect(await rolesOf(ANOTHER)).toEqual({ role: 'installer', roles: ['installer'] });
    // Given back only by a super admin.
    await expect(pg.query(`UPDATE profiles SET roles = ARRAY['finance', 'bookkeeper'] WHERE id = $1`, [PERSON]))
      .rejects.toThrow('permission denied: only a super admin can give the bookkeeper role');
  });

  it("leaves the server's own writes alone", async () => {
    await as(null);
    await pg.query(`UPDATE profiles SET roles = ARRAY['finance', 'cpa', 'bookkeeper'] WHERE id = $1`, [PERSON]);
    expect(await rolesOf(PERSON)).toEqual({ role: 'finance', roles: ['finance', 'cpa', 'bookkeeper'] });
  });
});
