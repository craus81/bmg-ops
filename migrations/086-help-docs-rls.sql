-- Migration 086: Allow all approved users to read help-category knowledge docs
--
-- The default knowledge_docs SELECT policy (migration 016) restricts reads to
-- admin / sales / production roles. The help library (docs/help/*.md, synced
-- via scripts/sync-help-docs.mjs) is meant to be queryable by everyone — the
-- FleetSuite AI uses the service role and bypasses RLS already, but a future
-- in-app help search surface will hit the table directly under the user's
-- session, so we broaden read access for category='help' here.
--
-- INSERT / UPDATE / DELETE remain admin-only.

DROP POLICY IF EXISTS knowledge_docs_select_help ON knowledge_docs;

CREATE POLICY knowledge_docs_select_help ON knowledge_docs FOR SELECT
  USING (
    category = 'help'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
      AND status = 'approved'
    )
  );
