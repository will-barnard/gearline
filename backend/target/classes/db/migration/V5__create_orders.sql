-- Orders imported from external marketplaces
CREATE TABLE orders (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_order_id       VARCHAR(200) NOT NULL,
    marketplace_account_id  UUID NOT NULL REFERENCES marketplace_accounts(id),
    marketplace_type        VARCHAR(30) NOT NULL,
    order_status            VARCHAR(30) NOT NULL DEFAULT 'IMPORTED',

    -- Financial totals
    subtotal                NUMERIC(10, 2),
    shipping_total          NUMERIC(10, 2),
    tax_total               NUMERIC(10, 2),
    total_amount            NUMERIC(10, 2),
    currency                VARCHAR(3) NOT NULL DEFAULT 'USD',

    -- JSON line items, buyer info, shipping address
    line_items              JSONB NOT NULL DEFAULT '[]',
    buyer_info              JSONB,
    shipping_address        JSONB,

    marketplace_order_url   VARCHAR(500),
    imported_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fulfilled_at            TIMESTAMPTZ,

    version                 BIGINT NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_orders_type_external UNIQUE (marketplace_type, external_order_id),
    CONSTRAINT chk_order_status CHECK (order_status IN (
        'IMPORTED','ACKNOWLEDGED','PROCESSING','SHIPPED','DELIVERED','CANCELLED','REFUNDED','DISPUTED'
    ))
);

CREATE INDEX idx_orders_external_id ON orders(external_order_id);
CREATE INDEX idx_orders_marketplace_type ON orders(marketplace_type);
CREATE INDEX idx_orders_status ON orders(order_status);
CREATE INDEX idx_orders_account_id ON orders(marketplace_account_id);
CREATE INDEX idx_orders_imported_at ON orders(imported_at DESC);

COMMENT ON TABLE orders IS 'Orders imported from external marketplaces — read-only import, not the fulfilment system';
