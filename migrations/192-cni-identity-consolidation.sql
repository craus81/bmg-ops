-- Migration 192: CNI identity consolidation (docs/cni-redesign.md §1.5, Phase 1)
--
-- profiles.company_id → companies is the single membership source of truth.
-- cni_profiles.company_name was a denormalized free-text copy kept only as a
-- transitional display fallback (the invite route and installer page have
-- written company_id + find-or-create companies for a while now). This
-- migration finishes the job:
--
--   1. Backfill: any installer whose membership exists only as a company_name
--      string gets a real companies row (find-or-create by name) + company_id.
--   2. Every remaining company-less active installer gets a ONE-PERSON company
--      named after them (resolved 2026-06-29: every installer belongs to a
--      company; solo = a one-person company; no "Independent" path).
--   3. Drop company_name and the dead fields nothing reads (skill_level,
--      referred_by). primary_contact_name is NOT dropped — the June audit
--      called it dead, but installer self-onboarding and the installer
--      profile page now read/write it as the person's contact name.
--
-- Code in the same deploy stops selecting/writing these columns.

-- 1. Find-or-create companies from the legacy name string.
DO $$
DECLARE
  r RECORD;
  cid UUID;
BEGIN
  FOR r IN
    SELECT cp.user_id, trim(cp.company_name) AS cname
    FROM cni_profiles cp
    JOIN profiles p ON p.id = cp.user_id
    WHERE p.company_id IS NULL
      AND cp.company_name IS NOT NULL
      AND trim(cp.company_name) <> ''
  LOOP
    SELECT id INTO cid FROM companies WHERE lower(name) = lower(r.cname) LIMIT 1;
    IF cid IS NULL THEN
      INSERT INTO companies (name) VALUES (r.cname) RETURNING id INTO cid;
    END IF;
    UPDATE profiles SET company_id = cid WHERE id = r.user_id;
  END LOOP;
END $$;

-- 2. One-person companies for active installers with no company at all.
DO $$
DECLARE
  r RECORD;
  cid UUID;
BEGIN
  FOR r IN
    SELECT cp.user_id,
           coalesce(nullif(trim(p.full_name), ''), p.email, 'Installer') AS pname
    FROM cni_profiles cp
    JOIN profiles p ON p.id = cp.user_id
    WHERE p.company_id IS NULL
      AND coalesce(p.deactivated, false) = false
  LOOP
    SELECT id INTO cid FROM companies WHERE lower(name) = lower(r.pname) LIMIT 1;
    IF cid IS NULL THEN
      INSERT INTO companies (name) VALUES (r.pname) RETURNING id INTO cid;
    END IF;
    UPDATE profiles SET company_id = cid WHERE id = r.user_id;
  END LOOP;
END $$;

-- 3. Drop the transitional copy and the dead fields.
ALTER TABLE cni_profiles
  DROP COLUMN IF EXISTS company_name,
  DROP COLUMN IF EXISTS skill_level,
  DROP COLUMN IF EXISTS referred_by;
