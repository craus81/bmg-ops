-- Migration 208: estimate ↔ wrap-quote linkage (Add Graphics flow)
--
-- Craig 2026-08-17: from an estimate, jump to the wrap-quote builder,
-- price the graphics, and land the result back on the estimate as lines.
-- Two columns carry the linkage:
--   - estimate_line_items.wrap_quote_id: which wrap quote produced the
--     line — re-adding after a quote edit REPLACES these lines instead of
--     duplicating them.
--   - wrap_quotes.estimate_id: which estimate the quote belongs to — the
--     wrap-quote screen shows it and suppresses the standalone NetSuite
--     push (the estimate carries the price now; a second NS estimate
--     would double-bill).

ALTER TABLE estimate_line_items ADD COLUMN IF NOT EXISTS wrap_quote_id UUID REFERENCES wrap_quotes(id) ON DELETE SET NULL;
ALTER TABLE wrap_quotes ADD COLUMN IF NOT EXISTS estimate_id UUID REFERENCES estimates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_estimate_lines_wrap_quote ON estimate_line_items(wrap_quote_id) WHERE wrap_quote_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wrap_quotes_estimate ON wrap_quotes(estimate_id) WHERE estimate_id IS NOT NULL;
