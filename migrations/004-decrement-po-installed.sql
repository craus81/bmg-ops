-- Add decrement function for PO line installed count (used by match review)
CREATE OR REPLACE FUNCTION decrement_po_installed(p_line_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE po_line_items
  SET installed = GREATEST(installed - 1, 0)
  WHERE id = p_line_id;
END;
$$ LANGUAGE plpgsql;
