-- Canonical product catalog — source of truth for all marketplace listings
CREATE TABLE products (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku                         VARCHAR(100) NOT NULL UNIQUE,
    title                       VARCHAR(500) NOT NULL,
    description                 TEXT,
    brand                       VARCHAR(200),
    category                    VARCHAR(100),
    condition                   VARCHAR(20) NOT NULL,
    price                       NUMERIC(10, 2) NOT NULL,
    quantity                    INTEGER NOT NULL DEFAULT 0,
    weight_kg                   NUMERIC(8, 3),
    dim_length_cm               NUMERIC(8, 2),
    dim_width_cm                NUMERIC(8, 2),
    dim_height_cm               NUMERIC(8, 2),
    serial_number               VARCHAR(100),
    image_urls                  JSONB NOT NULL DEFAULT '[]',

    -- Shopify source traceability (does NOT mean Shopify owns these records)
    shopify_product_id          VARCHAR(50),
    shopify_variant_id          VARCHAR(50),
    shopify_inventory_item_id   VARCHAR(50),

    status                      VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    version                     BIGINT NOT NULL DEFAULT 0,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_products_condition CHECK (condition IN (
        'MINT','EXCELLENT','VERY_GOOD','GOOD','FAIR','POOR','NEW','OPEN_BOX','USED','FOR_PARTS'
    )),
    CONSTRAINT chk_products_status CHECK (status IN ('ACTIVE','INACTIVE','ARCHIVED','DELETED')),
    CONSTRAINT chk_products_price_positive CHECK (price >= 0),
    CONSTRAINT chk_products_quantity_non_negative CHECK (quantity >= 0)
);

CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_brand ON products(brand);
CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_condition ON products(condition);
CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_products_shopify_product_id ON products(shopify_product_id);

COMMENT ON TABLE products IS 'Canonical product catalog — never contains marketplace-specific fields';
COMMENT ON COLUMN products.image_urls IS 'Ordered array of image URLs as JSON';
COMMENT ON COLUMN products.version IS 'Optimistic locking version — prevents oversell race conditions';
