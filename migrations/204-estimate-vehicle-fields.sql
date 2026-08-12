-- Migration 204: vehicle fields on estimates + per-platform option config
--
-- Craig 2026-08-12: the vehicle must LIVE on the estimate whether or not
-- a VIN exists — platform (make+model), year, and the qualifiers that
-- gate fitment: roof/wheelbase for vans, cab/bed for trucks. Selects
-- cascade from vehicle_platforms.config so only options that exist for
-- that platform are offered (Transit: 130/148/148 EL × low/med/high;
-- ProMaster: 118/136/159 × low/high/super high; …). VIN decode fills
-- these fields when it can; hands type them when it can't.

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS vehicle_platform_id UUID REFERENCES vehicle_platforms(id);
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS vehicle_year TEXT;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS vehicle_wheelbase TEXT;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS vehicle_roof TEXT;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS vehicle_cab TEXT;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS vehicle_bed TEXT;

-- Allowed qualifier options per platform: {wheelbases:[], roofs:[], cabs:[], beds:[]}
ALTER TABLE vehicle_platforms ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE vehicle_platforms SET config = c.config::jsonb FROM (VALUES
  ('transit',               '{"wheelbases":["130","148","148 EL"],"roofs":["low","medium","high"]}'),
  ('transit-connect',       '{"wheelbases":["SWB","LWB"]}'),
  ('promaster',             '{"wheelbases":["118","136","159","159 EXT"],"roofs":["low","high","super high"]}'),
  ('sprinter',              '{"wheelbases":["144","170","170 EXT"],"roofs":["standard","high"]}'),
  ('metris',                '{"wheelbases":["126","135"]}'),
  ('express-savana',        '{"wheelbases":["135","155"]}'),
  ('f-150',                 '{"cabs":["Regular","SuperCab","SuperCrew"],"beds":["5.5","6.5","8"]}'),
  ('super-duty',            '{"cabs":["Regular","SuperCab","Crew"],"beds":["6.75","8"]}'),
  ('maverick',              '{"cabs":["SuperCrew"],"beds":["4.5"]}'),
  ('ram-1500',              '{"cabs":["Regular","Quad","Crew"],"beds":["5.6","6.4","8"]}'),
  ('ram-hd',                '{"cabs":["Regular","Crew","Mega"],"beds":["6.3","8"]}'),
  ('silverado-sierra-1500', '{"cabs":["Regular","Double","Crew"],"beds":["5.8","6.6","8.2"]}'),
  ('silverado-sierra-hd',   '{"cabs":["Regular","Double","Crew"],"beds":["6.9","8.2"]}'),
  ('frontier',              '{"cabs":["King","Crew"],"beds":["5","6.1"]}'),
  ('tacoma',                '{"cabs":["XtraCab","Double"],"beds":["5","6"]}')
) AS c(key, config)
WHERE vehicle_platforms.key = c.key AND vehicle_platforms.config = '{}'::jsonb;
