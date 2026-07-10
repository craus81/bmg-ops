-- Coverage diagram for wrap quotes: at save time the estimator rasterizes
-- its canvas (vehicle outline template + the drawn coverage shapes, colored
-- by film) to a PNG and uploads it to the public vehicle-templates bucket
-- under quote-diagrams/. This column stores that bucket path so the quote
-- preview, history view, and the emailed quote can show the customer
-- exactly which panels are covered.
ALTER TABLE wrap_quotes ADD COLUMN IF NOT EXISTS diagram_path TEXT;
