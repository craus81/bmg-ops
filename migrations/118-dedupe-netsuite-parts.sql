-- Migration 118: De-duplicate netsuite_parts by item number
--
-- Legacy data left more than one row for the same item number:
--   * pre-merge "add to catalog" mirrors with fake netsuite_ids (LOCAL-…, bmg-…)
--   * the manual rows folded in from the old proof catalog by migration 117
--   * the real NetSuite-synced rows
--
-- Collapse each item number down to a single winner: move every foreign-key
-- reference onto the winner, merge useful graphics metadata + price onto it,
-- then delete the losers. Runs inside the migration runner's transaction, so a
-- failure rolls back cleanly. Idempotent — a second run is a no-op once every
-- item number is unique.

DO $$
DECLARE
  grp       RECORD;
  winner    netsuite_parts%ROWTYPE;
  loser_ids uuid[];
BEGIN
  FOR grp IN
    SELECT lower(item_number) AS k
    FROM netsuite_parts
    WHERE item_number IS NOT NULL AND item_number <> ''
    GROUP BY lower(item_number)
    HAVING count(*) > 1
  LOOP
    -- Rank the rows in this item-number group; the top row wins. Prefer a real
    -- NetSuite row, then an active one, then an informative name, then a price.
    SELECT * INTO winner
    FROM netsuite_parts
    WHERE lower(item_number) = grp.k
    ORDER BY
      (source = 'netsuite'
        AND netsuite_id IS NOT NULL
        AND netsuite_id NOT LIKE 'LOCAL-%'
        AND netsuite_id NOT LIKE 'bmg-%') DESC,
      is_active DESC,
      (display_name IS NOT NULL AND display_name <> item_number) DESC,
      COALESCE(sales_price, 0) DESC,
      created_at ASC,
      id ASC
    LIMIT 1;

    SELECT array_agg(id) INTO loser_ids
    FROM netsuite_parts
    WHERE lower(item_number) = grp.k AND id <> winner.id;

    -- Merge graphics metadata + price onto the winner where it is missing.
    UPDATE netsuite_parts w
    SET
      vehicle_type      = COALESCE(w.vehicle_type, l.vehicle_type),
      graphic_package   = COALESCE(w.graphic_package, l.graphic_package),
      customer          = COALESCE(w.customer, l.customer),
      proof_pages       = COALESCE(w.proof_pages, l.proof_pages, 1),
      billable_customer = COALESCE(NULLIF(w.billable_customer, ''), l.billable_customer),
      sales_price       = CASE WHEN COALESCE(w.sales_price, 0) = 0
                               THEN COALESCE(l.sales_price, 0) ELSE w.sales_price END,
      display_name      = CASE WHEN w.display_name IS NULL OR w.display_name = w.item_number
                               THEN COALESCE(l.display_name, w.display_name) ELSE w.display_name END,
      updated_at        = now()
    FROM (
      SELECT
        max(vehicle_type)                       AS vehicle_type,
        max(graphic_package)                    AS graphic_package,
        max(customer)                           AS customer,
        max(proof_pages)                        AS proof_pages,
        max(NULLIF(billable_customer, ''))      AS billable_customer,
        max(sales_price)                        AS sales_price,
        max(NULLIF(display_name, item_number))  AS display_name
      FROM netsuite_parts
      WHERE id = ANY(loser_ids)
    ) l
    WHERE w.id = winner.id;

    -- Move every foreign-key reference from the losers onto the winner.
    UPDATE po_line_items       SET part_id = winner.id WHERE part_id = ANY(loser_ids);
    UPDATE estimate_line_items SET part_id = winner.id WHERE part_id = ANY(loser_ids);

    -- part_files cascades on delete, so move it before deleting the losers.
    -- Drop loser files that would duplicate one the winner already has.
    DELETE FROM part_files pf
    WHERE pf.part_id = ANY(loser_ids)
      AND EXISTS (
        SELECT 1 FROM part_files w
        WHERE w.part_id = winner.id AND w.storage_path = pf.storage_path
      );
    UPDATE part_files SET part_id = winner.id WHERE part_id = ANY(loser_ids);

    -- schedule_assignments only exists in some environments.
    IF to_regclass('public.schedule_assignments') IS NOT NULL THEN
      UPDATE schedule_assignments SET part_id = winner.id WHERE part_id = ANY(loser_ids);
    END IF;

    -- Remove the absorbed rows.
    DELETE FROM netsuite_parts WHERE id = ANY(loser_ids);
  END LOOP;
END $$;
