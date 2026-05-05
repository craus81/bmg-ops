-- Track who has opened each graphics job and when.
-- Lets the producer/creator see which production-team members have actually
-- looked at the job.

CREATE TABLE IF NOT EXISTS graphics_job_views (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES graphics_jobs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  first_viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  view_count INT NOT NULL DEFAULT 1,
  UNIQUE (job_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_graphics_job_views_job_id ON graphics_job_views(job_id);

ALTER TABLE graphics_job_views ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'graphics_job_views' AND policyname = 'gjv_select_all'
  ) THEN
    CREATE POLICY "gjv_select_all" ON graphics_job_views
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

-- Atomic upsert: insert on first view, increment view_count + bump
-- last_viewed_at on subsequent views. SECURITY DEFINER so callers don't need
-- direct INSERT/UPDATE rights on the table — they can only record views as
-- themselves via auth.uid().
CREATE OR REPLACE FUNCTION public.record_graphics_job_view(p_job_id UUID)
RETURNS VOID AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.graphics_job_views (job_id, user_id)
  VALUES (p_job_id, auth.uid())
  ON CONFLICT (job_id, user_id) DO UPDATE
  SET last_viewed_at = NOW(),
      view_count = public.graphics_job_views.view_count + 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '';

GRANT EXECUTE ON FUNCTION public.record_graphics_job_view(UUID) TO authenticated;
