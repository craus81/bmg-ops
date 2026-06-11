-- Migration 078: Auto-handoffs between upfit projects, fleet check-ins, and in-shop tracking
--
-- When a fleet_checkin is created matching an upfit project's SO (by netsuite_sales_order_id
-- or sales_order_number), the project is linked and advanced to 'in_progress'.
-- When a fleet_checkin is marked 'shipped', the linked upfit project is marked 'completed'.
-- Every handoff also drops a note on the project's activity timeline.

CREATE OR REPLACE FUNCTION upfit_link_on_checkin() RETURNS TRIGGER AS $$
DECLARE
  matched_id UUID;
BEGIN
  SELECT id INTO matched_id
  FROM upfit_projects
  WHERE (NEW.netsuite_sales_order_id IS NOT NULL AND netsuite_so_id = NEW.netsuite_sales_order_id)
     OR (NEW.sales_order_number IS NOT NULL AND netsuite_so_number = NEW.sales_order_number)
  ORDER BY
    CASE WHEN NEW.netsuite_sales_order_id IS NOT NULL AND netsuite_so_id = NEW.netsuite_sales_order_id THEN 0 ELSE 1 END,
    updated_at DESC
  LIMIT 1;

  IF matched_id IS NOT NULL THEN
    UPDATE upfit_projects
    SET
      fleet_checkin_id = NEW.id,
      status = CASE
        WHEN status IN (
          'opportunity', 'estimate', 'sold',
          'parts_ordered', 'parts_arrived', 'parts_in_stock',
          'scheduled_dropoff', 'scheduled_build'
        ) THEN 'in_progress'
        ELSE status
      END,
      updated_at = NOW()
    WHERE id = matched_id;

    INSERT INTO upfit_project_notes (project_id, note_type, content, created_by)
    VALUES (
      matched_id,
      'checkin',
      'Vehicle checked in: VIN ' || NEW.vin,
      NEW.checked_in_by
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fleet_checkin_link_upfit ON fleet_checkins;
CREATE TRIGGER fleet_checkin_link_upfit
  AFTER INSERT ON fleet_checkins
  FOR EACH ROW EXECUTE FUNCTION upfit_link_on_checkin();


CREATE OR REPLACE FUNCTION upfit_complete_on_ship() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'shipped' AND (OLD.status IS NULL OR OLD.status <> 'shipped') THEN
    UPDATE upfit_projects
    SET status = 'completed', updated_at = NOW()
    WHERE fleet_checkin_id = NEW.id
      AND status NOT IN ('completed', 'cancelled');

    INSERT INTO upfit_project_notes (project_id, note_type, content, created_by)
    SELECT id, 'completion', 'Vehicle shipped: ' || NEW.vin, NEW.checked_in_by
    FROM upfit_projects
    WHERE fleet_checkin_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fleet_checkin_complete_upfit ON fleet_checkins;
CREATE TRIGGER fleet_checkin_complete_upfit
  AFTER UPDATE OF status ON fleet_checkins
  FOR EACH ROW EXECUTE FUNCTION upfit_complete_on_ship();
