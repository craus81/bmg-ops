-- Migration 122: company is the single source of truth for CNI installer membership
--
-- Phase 1 of the CNI redesign (docs/cni-redesign.md §1.5). Today an installer's
-- company lives in two places: the authoritative `profiles.company_id ->
-- companies` link AND a denormalized free-text `cni_profiles.company_name` that
-- drifts. This backfill makes `company_id` correct for every installer so the
-- app can read company from `companies.name` and stop depending on the string.
--
-- ADDITIVE ONLY — this does not drop `company_name` or any dead column. A later
-- migration removes them once every reader is off the denormalized copy.
-- Policy (resolved): every installer belongs to a company; a solo installer is
-- a one-person company.

-- 1) Installers who have a free-text company_name but no company_id:
--    find-or-create a companies row by (case-insensitive) name, then link it.
DO $$
DECLARE r RECORD; cid UUID;
BEGIN
  FOR r IN
    SELECT p.id AS pid, btrim(cp.company_name) AS cname
    FROM profiles p
    JOIN cni_profiles cp ON cp.user_id = p.id
    WHERE p.company_id IS NULL
      AND cp.company_name IS NOT NULL
      AND btrim(cp.company_name) <> ''
      AND (p.role = 'installer' OR 'installer' = ANY(COALESCE(p.roles, '{}')))
  LOOP
    SELECT id INTO cid FROM companies WHERE lower(name) = lower(r.cname) LIMIT 1;
    IF cid IS NULL THEN
      INSERT INTO companies (name) VALUES (r.cname) RETURNING id INTO cid;
    END IF;
    UPDATE profiles SET company_id = cid WHERE id = r.pid;
  END LOOP;
END $$;

-- 2) Installers with neither a company_id nor a usable company_name:
--    create a one-person company from their full name and link it, so no
--    active installer is left company-less.
DO $$
DECLARE r RECORD; cid UUID; nm TEXT;
BEGIN
  FOR r IN
    SELECT p.id AS pid,
           COALESCE(NULLIF(btrim(p.full_name), ''), 'Installer ' || left(p.id::text, 8)) AS fname
    FROM profiles p
    LEFT JOIN cni_profiles cp ON cp.user_id = p.id
    WHERE p.company_id IS NULL
      AND (p.role = 'installer' OR 'installer' = ANY(COALESCE(p.roles, '{}')))
      AND (cp.company_name IS NULL OR btrim(cp.company_name) = '')
  LOOP
    nm := r.fname;
    SELECT id INTO cid FROM companies WHERE lower(name) = lower(nm) LIMIT 1;
    IF cid IS NULL THEN
      INSERT INTO companies (name) VALUES (nm) RETURNING id INTO cid;
    END IF;
    UPDATE profiles SET company_id = cid WHERE id = r.pid;
  END LOOP;
END $$;

-- 3) Keep cni_profiles.company_name in sync with the now-authoritative company
--    as a display fallback during the transition. A later migration drops the
--    column once every reader uses company_id -> companies.name.
UPDATE cni_profiles cp
SET company_name = c.name
FROM profiles p
JOIN companies c ON c.id = p.company_id
WHERE cp.user_id = p.id
  AND p.company_id IS NOT NULL;
