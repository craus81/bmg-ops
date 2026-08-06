-- Customer-facing presentation choice for a wrap quote: hide the itemized
-- measurement/labor rows while keeping the coverage picture and the money
-- (subtotal / tax / total). Set by the send flow whenever a quote goes out
-- (from the "itemized line items" checkbox), then read by the public
-- acceptance page (which strips line data SERVER-side) and the signed
-- acceptance snapshot — so what the customer accepts always matches what
-- they were sent. (Roadmap W2 — "i want the Line items not to show up but
-- i want the picture to".)
ALTER TABLE wrap_quotes
  ADD COLUMN IF NOT EXISTS hide_line_items BOOLEAN NOT NULL DEFAULT false;
