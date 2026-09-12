-- In-App Help Center (R6-13, audit line 431)
--
-- /api/admin/sync-help-docs already loads docs/help/**.md into
-- knowledge_docs with category 'help', and it already COMPUTES each file's
-- repo-relative path — it just never stored it. Without that path a guide
-- has no stable identity: the only handle is its title, which changes the
-- moment someone edits an H1, and the tag list, which is derived and
-- ambiguous.
--
-- Storing it gives the Help Center a slug to deep-link, which is what lets
-- the "?" on a page open THAT page's guide instead of the library index.

ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS source_path TEXT;

-- Help guides are addressed by path, so it has to be unique among them.
-- Partial: nothing else in the knowledge base has a source path.
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_docs_help_path
  ON knowledge_docs(source_path)
  WHERE category = 'help' AND source_path IS NOT NULL;
