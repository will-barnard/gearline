-- Rename product dimension columns from centimetres to inches.
-- Dimensions are entered by the seller in inches (US market) and sent to
-- eBay / Reverb in inches directly — no unit conversion needed.
-- Previously named _cm but never populated in production, so no data to convert.

ALTER TABLE products
    RENAME COLUMN dim_length_cm TO dim_length_in;

ALTER TABLE products
    RENAME COLUMN dim_width_cm TO dim_width_in;

ALTER TABLE products
    RENAME COLUMN dim_height_cm TO dim_height_in;
