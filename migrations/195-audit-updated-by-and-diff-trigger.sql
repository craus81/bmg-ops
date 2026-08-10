-- Migration 195: audit expansion — updated_by + row-diff trigger (A2 ph 2-3)
--
-- Roadmap A2: ~40 of ~137 job-record mutation sites are client-side direct
-- Supabase updates that per-call-site instrumentation can't reach. A
-- SECURITY DEFINER row-diff trigger catches all of them by construction.
-- Actor attribution follows the cni_jobs precedent (migrations 115 + 045):
-- COALESCE(NEW.updated_by, auth.uid()) — browser writes carry the user's
-- JWT so auth.uid() resolves; service-role routes set updated_by when a
-- user drove the action, and a NULL actor deliberately reads as
-- "system" (crons, webhooks, syncs).
--
-- Tranche 1 per the roadmap's phasing: triggers on upfit_projects,
-- graphics_jobs, cni_jobs only — the low-volume/high-value tables.
-- fleet_checkins and purchase_orders get columns now but NO trigger yet:
-- bulk syncs write them constantly and the volume/retention question is
-- explicitly unresolved (roadmap A2 "honest risks").

-- ── Phase 2: updated_by on the six job tables (cni_jobs has it via 115) ──
ALTER TABLE graphics_jobs   ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES profiles(id);
ALTER TABLE fleet_checkins  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES profiles(id);
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES profiles(id);
ALTER TABLE estimates       ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES profiles(id);
ALTER TABLE upfit_projects  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES profiles(id);
ALTER TABLE wrap_quotes     ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES profiles(id);

-- ── Phase 3: generic row-diff audit trigger ──
-- TG_ARGV carries the per-table noisy-column ignore list. Unchanged rows
-- and rows where only ignored columns moved write nothing.
CREATE OR REPLACE FUNCTION public.audit_row_diff()
RETURNS TRIGGER AS $$
DECLARE
  v_old JSONB;
  v_new JSONB;
  v_changed JSONB := '{}'::jsonb;
  v_key TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The event you most want recorded: capture the whole row before it
    -- goes (e.g. the graphics page hard-delete).
    INSERT INTO public.audit_log (actor_id, table_name, record_id, action, detail)
    VALUES (auth.uid(), TG_TABLE_NAME, (to_jsonb(OLD)->>'id'), 'row_delete',
            jsonb_build_object('deleted', to_jsonb(OLD)));
    RETURN OLD;
  END IF;

  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);
  FOR v_key IN SELECT jsonb_object_keys(v_new) LOOP
    CONTINUE WHEN v_key = ANY (TG_ARGV);
    IF v_old->v_key IS DISTINCT FROM v_new->v_key THEN
      v_changed := v_changed
        || jsonb_build_object(v_key, jsonb_build_object('from', v_old->v_key, 'to', v_new->v_key));
    END IF;
  END LOOP;

  IF v_changed = '{}'::jsonb THEN RETURN NEW; END IF;

  INSERT INTO public.audit_log (actor_id, table_name, record_id, action, detail)
  VALUES (
    COALESCE(NULLIF(v_new->>'updated_by', '')::uuid, auth.uid()),
    TG_TABLE_NAME,
    v_new->>'id',
    'row_update',
    jsonb_build_object('changed', v_changed)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '';

-- updated_at/updated_by always ignored (they move on every write). Per
-- table, also ignore cron/sync-churned columns so reminders and calendar
-- syncs don't flood the log.
DROP TRIGGER IF EXISTS trg_audit_upfit_projects ON upfit_projects;
CREATE TRIGGER trg_audit_upfit_projects
  AFTER UPDATE OR DELETE ON upfit_projects
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_diff('updated_at', 'updated_by');

DROP TRIGGER IF EXISTS trg_audit_graphics_jobs ON graphics_jobs;
CREATE TRIGGER trg_audit_graphics_jobs
  AFTER UPDATE OR DELETE ON graphics_jobs
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_diff(
    'updated_at', 'updated_by',
    'calendar_event_id',            -- calendar sync churn
    'approval_reminder_sent_at',    -- proof-reminder cron churn
    'approval_reminder_count'
  );

DROP TRIGGER IF EXISTS trg_audit_cni_jobs ON cni_jobs;
CREATE TRIGGER trg_audit_cni_jobs
  AFTER UPDATE OR DELETE ON cni_jobs
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_diff(
    'updated_at', 'updated_by',
    'bid_count'                     -- bidding counter churn
  );
