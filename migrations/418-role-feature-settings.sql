-- Migration 418: role-wide permission switches (More → Admin → Permissions)
--
-- Owner ask 2026-10-20: "select the check boxes for when i want to change
-- permissions by myself". Each row changes ONE role's default for ONE
-- feature key (src/lib/features.ts FEATURES); no row = the code default.
-- Resolution order everywhere (AuthProvider, requireFeature, badges, CNI
-- audiences): code default → this table → the person's own
-- user_feature_overrides row. super_admin rows are ignored by the resolver.
--
-- Written only by /api/admin/role-permissions (service role, super_admin
-- gate), so there is no write policy. Every signed-in account reads it: the
-- browser resolves its own menus from it, and the switches are not secret.

CREATE TABLE IF NOT EXISTS public.role_feature_settings (
  role TEXT NOT NULL,
  feature TEXT NOT NULL,
  granted BOOLEAN NOT NULL,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role, feature)
);

ALTER TABLE public.role_feature_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "role_feature_settings_read" ON public.role_feature_settings;
CREATE POLICY "role_feature_settings_read" ON public.role_feature_settings
  FOR SELECT TO authenticated USING (true);
