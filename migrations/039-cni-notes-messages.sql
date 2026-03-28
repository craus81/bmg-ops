-- Migration 039: CNI Internal Notes + Job Messages
-- Phase 3 — Execution & Completion

-- ─────────────────────────────────────────
-- Table: cni_internal_notes
-- Internal-only notes on installer profiles (NEVER visible to installers)
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cni_internal_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installer_id UUID REFERENCES profiles(id) NOT NULL,
  note_type TEXT NOT NULL DEFAULT 'general' CHECK (note_type IN ('general', 'issue', 'qc')),
  content TEXT NOT NULL,
  auto_generated BOOLEAN DEFAULT FALSE,
  source_job_id UUID REFERENCES cni_jobs(id),
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cni_internal_notes_installer ON cni_internal_notes(installer_id);

-- RLS — NEVER expose to installers
ALTER TABLE cni_internal_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_full_cni_internal_notes" ON cni_internal_notes
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (role = 'admin' OR 'admin' = ANY(roles)))
  );
-- No installer policy = installers cannot see this table at all


-- ─────────────────────────────────────────
-- Table: cni_job_messages
-- Job-scoped messaging between coordinator and installer
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cni_job_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES cni_jobs(id) ON DELETE CASCADE NOT NULL,
  sender_id UUID REFERENCES profiles(id) NOT NULL,
  body TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cni_job_messages_job ON cni_job_messages(job_id);
CREATE INDEX idx_cni_job_messages_created ON cni_job_messages(job_id, created_at);

-- RLS
ALTER TABLE cni_job_messages ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "admin_full_cni_job_messages" ON cni_job_messages
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (role = 'admin' OR 'admin' = ANY(roles)))
  );

-- Installers: read/write on assigned jobs
CREATE POLICY "installer_rw_own_job_messages" ON cni_job_messages
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_installer_id = auth.uid()
    )
  );
