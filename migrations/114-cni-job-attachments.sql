-- Job attachments: proofs, photos, and other files that describe a CNI job,
-- attached at creation (or later) and visible to the assigned company's
-- installers. Stored as [{ "name": "...", "path": "..." }] in R2 (bucket
-- 'photos', prefix 'cni-job-files/<jobId>/'); the legacy proof_file_paths /
-- design_file_paths arrays are left as-is.

ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'::jsonb;
