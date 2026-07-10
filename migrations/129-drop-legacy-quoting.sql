-- Remove the legacy AI quoting tools' data. The /admin/quotes (AI proof
-- quoting) and /admin/wrap-estimator pages are deleted from the app in the
-- same change; /admin/wrap-quote (wrap_quotes + wrap_substrates +
-- wrap_quote_settings, migration 128) replaces both.
--
-- DESTRUCTIVE: this permanently deletes all legacy quote rows, their panel
-- breakdowns, and nesting elements. Confirmed intentional — the legacy
-- quotes are experiments, not business records. vehicle_templates is KEPT
-- (the wrap-quote estimator uses it); stored proof files under the
-- quote-proofs prefix in R2 become orphans and can be cleaned up later.
DROP TABLE IF EXISTS quote_elements;
DROP TABLE IF EXISTS quote_panels;
DROP TABLE IF EXISTS quotes;
