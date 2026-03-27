-- Add panel_data column if it doesn't exist (JSONB array of panel dimensions)
ALTER TABLE vehicle_templates ADD COLUMN IF NOT EXISTS panel_data jsonb DEFAULT '[]'::jsonb;

-- Populate panel data for Chevrolet Express (Short Wheelbase) based on Art Station templates
-- Art Station file: Exp_year_01, dimensions from www.artstation-vehicletemplates.com
UPDATE vehicle_templates
SET
  overall_length_in = 217.4,
  overall_height_in = 72,
  wheelbase_in = 135,
  panel_data = '[
    {"name": "Driver Side", "width_in": 222, "height_in": 72, "area_sqft": 111.00},
    {"name": "Passenger Side", "width_in": 222, "height_in": 72, "area_sqft": 111.00},
    {"name": "Rear", "width_in": 78, "height_in": 60, "area_sqft": 39.00},
    {"name": "Hood/Front", "width_in": 40, "height_in": 72, "area_sqft": 19.98},
    {"name": "Roof", "width_in": 171, "height_in": 75, "area_sqft": 89.06},
    {"name": "Rear Upper", "width_in": 64, "height_in": 28, "area_sqft": 12.42},
    {"name": "Rear Quarter", "width_in": 40, "height_in": 78, "area_sqft": 21.65}
  ]'::jsonb
WHERE LOWER(make) = 'chevrolet' AND LOWER(model) IN ('express', 'express cargo');

-- Also match "chevy" shorthand
UPDATE vehicle_templates
SET
  overall_length_in = 217.4,
  overall_height_in = 72,
  wheelbase_in = 135,
  panel_data = '[
    {"name": "Driver Side", "width_in": 222, "height_in": 72, "area_sqft": 111.00},
    {"name": "Passenger Side", "width_in": 222, "height_in": 72, "area_sqft": 111.00},
    {"name": "Rear", "width_in": 78, "height_in": 60, "area_sqft": 39.00},
    {"name": "Hood/Front", "width_in": 40, "height_in": 72, "area_sqft": 19.98},
    {"name": "Roof", "width_in": 171, "height_in": 75, "area_sqft": 89.06},
    {"name": "Rear Upper", "width_in": 64, "height_in": 28, "area_sqft": 12.42},
    {"name": "Rear Quarter", "width_in": 40, "height_in": 78, "area_sqft": 21.65}
  ]'::jsonb
WHERE LOWER(make) = 'chevy' AND LOWER(model) IN ('express', 'express cargo');
