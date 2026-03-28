-- Migration 038: CNI Job Photos
-- Phase 3 — Execution & Completion: photo submission + review

CREATE TABLE IF NOT EXISTS cni_job_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES cni_jobs(id) ON DELETE CASCADE NOT NULL,
  vin_id UUID REFERENCES cni_job_vins(id) ON DELETE CASCADE,  -- NULL if single-unit job
  storage_path TEXT NOT NULL,
  photo_type TEXT NOT NULL CHECK (photo_type IN (
    'front', 'back', 'driver_side', 'passenger_side', 'vin_plate', 'detail', 'other'
  )),
  uploaded_by UUID REFERENCES profiles(id),
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),

  -- Review
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    review_status IN ('pending', 'approved', 'conditionally_approved', 'denied')
  ),
  reviewed_by UUID REFERENCES profiles(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT
);

CREATE INDEX idx_cni_job_photos_job ON cni_job_photos(job_id);
CREATE INDEX idx_cni_job_photos_vin ON cni_job_photos(vin_id);

-- RLS
ALTER TABLE cni_job_photos ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "admin_full_cni_job_photos" ON cni_job_photos
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (role = 'admin' OR 'admin' = ANY(roles)))
  );

-- Installers: create on assigned jobs, read own uploads
CREATE POLICY "installer_upload_photos" ON cni_job_photos
  FOR INSERT WITH CHECK (
    uploaded_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_installer_id = auth.uid()
    )
  );

CREATE POLICY "installer_read_own_photos" ON cni_job_photos
  FOR SELECT USING (
    uploaded_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_installer_id = auth.uid()
    )
  );
