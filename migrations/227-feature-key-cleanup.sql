-- Migration 227: feature-registry cleanup — rename + drop dead per-user overrides
--
-- Companion to the src/lib/features.ts registry cleanup (audit roadmap #18).
-- resolveFeatures() ignores any user_feature_overrides row whose `feature`
-- string is not currently in FEATURES, so a code rename WITHOUT this migration
-- silently drops the per-user grant/revoke. Renames and their data migration
-- ship together; the runner applies this before `next build` on deploy.
--
--   * proof_hygiene  → proof_search   (Proof Search page key)
--   * cni_management → cni_portal      (external installer portal key)
--
-- Also removes rows for the three deleted dead keys (harmless if absent —
-- resolveFeatures already ignores them, this just keeps the table tidy).
--
-- Idempotent; runs inside the migrate.mjs per-file transaction.

UPDATE user_feature_overrides SET feature = 'proof_search' WHERE feature = 'proof_hygiene';
UPDATE user_feature_overrides SET feature = 'cni_portal'   WHERE feature = 'cni_management';

DELETE FROM user_feature_overrides
WHERE feature IN ('photo_reviews', 'all_jobs', 'catalog_management');
