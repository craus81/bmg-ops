-- Track who has opened each upfit project and when — same read-receipts
-- pattern as graphics_job_views (migration 096). Lets a creator see whether
-- the team has actually looked at a project, and powers the board's
-- unread-activity dot.

CREATE TABLE IF NOT EXISTS upfit_project_views (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES upfit_projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  first_viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  view_count INT NOT NULL DEFAULT 1,
  UNIQUE (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_upfit_project_views_project_id ON upfit_project_views(project_id);

ALTER TABLE upfit_project_views ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'upfit_project_views' AND policyname = 'upv_select_all'
  ) THEN
    CREATE POLICY "upv_select_all" ON upfit_project_views
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

-- Atomic upsert: insert on first view, increment view_count + bump
-- last_viewed_at on subsequent views. SECURITY DEFINER so callers don't need
-- direct INSERT/UPDATE rights on the table — they can only record views as
-- themselves via auth.uid().
CREATE OR REPLACE FUNCTION public.record_upfit_project_view(p_project_id UUID)
RETURNS VOID AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.upfit_project_views (project_id, user_id)
  VALUES (p_project_id, auth.uid())
  ON CONFLICT (project_id, user_id) DO UPDATE
  SET last_viewed_at = NOW(),
      view_count = public.upfit_project_views.view_count + 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '';

GRANT EXECUTE ON FUNCTION public.record_upfit_project_view(UUID) TO authenticated;
