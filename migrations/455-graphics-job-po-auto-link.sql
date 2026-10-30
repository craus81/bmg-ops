-- Graphics jobs link themselves to their PO (Craig 2026-10-30, thread
-- "Store graphics tracking numbers on PO records").
--
-- The PO page, the search bar and the customer PO portal all find a job's
-- tracking number through graphics_jobs.po_id. A job with the customer's PO
-- number typed in but never linked ("PO #… on file, not linked") was
-- invisible to all three. A job now links itself when exactly ONE PO has
-- that number for the SAME customer — same NetSuite customer id when both
-- sides have one, otherwise the same customer name. No match, or more than
-- one, leaves it unlinked for + Link PO. Same customer is the rule that
-- keeps a job out of another customer's portal.
--
-- Fires on new jobs, on a job's PO number/customer changing while it is
-- unlinked, and on a PO being created or renumbered after the job. A job
-- that already has a PO is never moved, and clearing po_id (PO delete)
-- doesn't re-link: these triggers watch po_number/customer columns only.

-- "PO-12345", "PO# 12345", "po 12345" and "12345" compare equal; spaces
-- and case don't matter.
CREATE OR REPLACE FUNCTION normalize_po_number(v TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(
    regexp_replace(
      regexp_replace(lower(btrim(coalesce(v, ''))), '^p\.?o\.?[\s#:\-]*(?=[0-9])', ''),
      '\s+', '', 'g'),
    '')
$$;

-- The one PO a job's typed number + customer points at, or NULL.
CREATE OR REPLACE FUNCTION graphics_job_po_match(p_po_number TEXT, p_customer TEXT, p_customer_ns TEXT)
RETURNS UUID LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_key TEXT := normalize_po_number(p_po_number);
  v_cust TEXT := NULLIF(lower(btrim(coalesce(p_customer, ''))), '');
  v_ids UUID[];
BEGIN
  IF v_key IS NULL THEN RETURN NULL; END IF;
  SELECT array_agg(p.id) INTO v_ids
  FROM purchase_orders p
  WHERE normalize_po_number(p.po_number) = v_key
    AND CASE
      WHEN NULLIF(p_customer_ns, '') IS NOT NULL AND NULLIF(p.customer_netsuite_id, '') IS NOT NULL
        THEN p.customer_netsuite_id = p_customer_ns
      ELSE v_cust IS NOT NULL AND lower(btrim(coalesce(p.customer, ''))) = v_cust
    END;
  IF coalesce(array_length(v_ids, 1), 0) = 1 THEN RETURN v_ids[1]; END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION graphics_jobs_auto_link_po() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_po UUID;
BEGIN
  IF NEW.po_id IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.po_id IS NOT NULL THEN RETURN NEW; END IF;
  IF coalesce(NEW.status, '') = 'cancelled' THEN RETURN NEW; END IF;
  v_po := graphics_job_po_match(NEW.po_number, NEW.customer, NEW.customer_netsuite_id);
  IF v_po IS NULL THEN RETURN NEW; END IF;
  NEW.po_id := v_po;
  -- Narrow to one line by part number, like + Link PO; else "whole PO".
  IF NEW.po_line_item_id IS NULL AND NULLIF(btrim(coalesce(NEW.part_number, '')), '') IS NOT NULL THEN
    SELECT li.id INTO NEW.po_line_item_id
    FROM po_line_items li
    WHERE li.po_id = v_po AND lower(btrim(li.part_number)) = lower(btrim(NEW.part_number))
    ORDER BY li.id
    LIMIT 1;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS graphics_jobs_auto_link_po ON graphics_jobs;
CREATE TRIGGER graphics_jobs_auto_link_po
  BEFORE INSERT OR UPDATE OF po_number, customer, customer_netsuite_id ON graphics_jobs
  FOR EACH ROW EXECUTE FUNCTION graphics_jobs_auto_link_po();

-- A PO that arrives after its job: link the unlinked jobs it is the one
-- match for. Sets po_id only, so the job trigger above doesn't re-fire.
CREATE OR REPLACE FUNCTION purchase_orders_link_graphics_jobs() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF normalize_po_number(NEW.po_number) IS NULL THEN RETURN NEW; END IF;
  UPDATE graphics_jobs g
  SET po_id = NEW.id
  WHERE g.po_id IS NULL
    AND coalesce(g.status, '') <> 'cancelled'
    AND normalize_po_number(g.po_number) = normalize_po_number(NEW.po_number)
    AND graphics_job_po_match(g.po_number, g.customer, g.customer_netsuite_id) = NEW.id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS purchase_orders_link_graphics_jobs ON purchase_orders;
CREATE TRIGGER purchase_orders_link_graphics_jobs
  AFTER INSERT OR UPDATE OF po_number, customer, customer_netsuite_id ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION purchase_orders_link_graphics_jobs();

-- Existing jobs get the same check once.
UPDATE graphics_jobs g
SET po_line_item_id = (
      SELECT li.id FROM po_line_items li
      WHERE li.po_id = m.po_id
        AND NULLIF(btrim(coalesce(g.part_number, '')), '') IS NOT NULL
        AND lower(btrim(li.part_number)) = lower(btrim(g.part_number))
      ORDER BY li.id LIMIT 1),
    po_id = m.po_id
FROM (
  SELECT id, graphics_job_po_match(po_number, customer, customer_netsuite_id) AS po_id
  FROM graphics_jobs
  WHERE po_id IS NULL
    AND coalesce(status, '') <> 'cancelled'
    AND normalize_po_number(po_number) IS NOT NULL
) m
WHERE g.id = m.id AND m.po_id IS NOT NULL;

-- Tracking-number search (search bar, PO list).
CREATE INDEX IF NOT EXISTS idx_graphics_jobs_tracking ON graphics_jobs(tracking_number) WHERE tracking_number IS NOT NULL;
