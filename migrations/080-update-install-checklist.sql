-- Migration 080: Update default install checklist + add keyed tasks
--
-- The mixed-install default seeded by migration 073 used boilerplate
-- items that didn't match BMG's actual install ceremony. Replace with
-- the customer-validated list, and introduce a `task_key` column on
-- job_tasks so the new completion modal can recognise specific tasks
-- and render contextual UX (proof preview, sales-order line items).

-- 1) job_tasks gets task_key (carried from template item.key on instantiation)
ALTER TABLE job_tasks
  ADD COLUMN IF NOT EXISTS task_key TEXT;

-- 2) Deactivate old default templates so the active template lookup
--    finds the new one. Keeps history intact via is_active=false.
UPDATE install_checklist_templates
SET is_active = false, updated_at = NOW()
WHERE name LIKE 'Default — %' AND is_active = true;

-- 3) Insert the BMG-validated default templates. The keys (`graphics_per_proof`,
--    `upfit_per_spec`) are matched by the completion modal to render the proof
--    image inline and to pull SO line items as sub-checkboxes.

INSERT INTO install_checklist_templates (name, install_category, items)
VALUES (
  'Default — Mixed Install',
  'mixed',
  '[
    {"label": "Walkaround: exterior condition", "required": true},
    {"label": "Graphics applied per proof", "required": true, "key": "graphics_per_proof"},
    {"label": "No decal lifting, bubbles, wrinkles or imperfections", "required": true},
    {"label": "Upfit parts installed per spec", "required": true, "key": "upfit_per_spec"},
    {"label": "All hardware tightened", "required": true},
    {"label": "Interior cleaned", "required": true},
    {"label": "Final QC Check", "required": true}
  ]'::jsonb
);

INSERT INTO install_checklist_templates (name, install_category, items)
VALUES (
  'Default — Graphics Only',
  'graphics',
  '[
    {"label": "Walkaround: exterior condition", "required": true},
    {"label": "Graphics applied per proof", "required": true, "key": "graphics_per_proof"},
    {"label": "No decal lifting, bubbles, wrinkles or imperfections", "required": true},
    {"label": "Final QC Check", "required": true}
  ]'::jsonb
);

INSERT INTO install_checklist_templates (name, install_category, items)
VALUES (
  'Default — Upfit Only',
  'upfit',
  '[
    {"label": "Walkaround: exterior condition", "required": true},
    {"label": "Upfit parts installed per spec", "required": true, "key": "upfit_per_spec"},
    {"label": "All hardware tightened", "required": true},
    {"label": "Interior cleaned", "required": true},
    {"label": "Final QC Check", "required": true}
  ]'::jsonb
);
