-- Manual pricing on a wrap quote: the rep's final price, per-film vinyl and
-- install-labor rates, and the typed qty-discount field. Kept apart from the
-- customer-facing snapshot (measurements / labor / adjustments), which is
-- scaled to the final price so the quote reads normally, so reopening the
-- quote restores what the rep actually typed. NULL = no overrides (all
-- rows saved before this migration).
ALTER TABLE wrap_quotes ADD COLUMN IF NOT EXISTS pricing_overrides JSONB;
