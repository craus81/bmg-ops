-- Graphics install capacity (owner decision 2026-10-25): estimates carry
-- graphics install labor as a dollar line ("Graphics Install Labor"), not
-- hours. Shop Week and the drop-off booking warning turn those dollars into
-- hours by dividing by this one rate. NULL = not set; graphics hours then
-- stay unknown rather than being guessed.

ALTER TABLE quote_settings ADD COLUMN IF NOT EXISTS graphics_install_rate NUMERIC(8,2)
  CHECK (graphics_install_rate IS NULL OR (graphics_install_rate > 0 AND graphics_install_rate <= 10000));

COMMENT ON COLUMN quote_settings.graphics_install_rate IS
  'Dollars of Graphics Install Labor per install hour — divides estimate graphics labor into hours for capacity (Shop Week, drop-off warnings). NULL = not set.';
