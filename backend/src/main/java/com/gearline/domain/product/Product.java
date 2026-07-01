package com.gearline.domain.product;

import com.gearline.domain.audit.AuditableEntity;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@Entity
@Table(name = "products", indexes = {
    @Index(name = "idx_products_sku", columnList = "sku", unique = true),
    @Index(name = "idx_products_brand", columnList = "brand"),
    @Index(name = "idx_products_category", columnList = "category"),
    @Index(name = "idx_products_condition", columnList = "condition"),
    @Index(name = "idx_products_shopify_product_id", columnList = "shopify_product_id")
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder(toBuilder = true)
@ToString(exclude = "imageUrls")
@EqualsAndHashCode(of = "id", callSuper = false)
public class Product extends AuditableEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(nullable = false, updatable = false)
    private UUID id;

    @Column(nullable = false, unique = true, length = 100)
    private String sku;

    @Column(nullable = false, length = 500)
    private String title;

    @Column(columnDefinition = "TEXT")
    private String description;

    @Column(length = 200)
    private String brand;

    @Column(length = 100)
    private String category;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private ProductCondition condition;

    @Column(nullable = false, precision = 10, scale = 2)
    private BigDecimal price;

    @Column(nullable = false)
    private Integer quantity;

    @Column(precision = 8, scale = 3)
    private BigDecimal weightKg;

    @Embedded
    private Dimensions dimensions;

    @Column(length = 100)
    private String serialNumber;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    @Builder.Default
    private List<String> imageUrls = new ArrayList<>();

    /**
     * The Shopify product ID this was sourced from.
     * Lives on the product for traceability but does NOT indicate Shopify ownership.
     * Marketplace-specific identifiers live on MarketplaceListing.
     */
    @Column(name = "shopify_product_id", length = 50)
    private String shopifyProductId;

    @Column(name = "shopify_variant_id", length = 50)
    private String shopifyVariantId;

    @Column(name = "shopify_inventory_item_id", length = 50)
    private String shopifyInventoryItemId;

    /**
     * YouTube (or other) video URL for this product.
     * Synced automatically from the Shopify product metafield {@code custom.youtube_url}.
     * Forwarded to Reverb as {@code video_link} when a listing is published or updated.
     */
    @Column(name = "video_url", length = 500)
    private String videoUrl;

    /**
     * Instrument model name (e.g. "Stratocaster", "CP-70").
     * Synced from Shopify metafield {@code custom.reverb_model}.
     * Forwarded to Reverb as {@code model}; Reverb requires both make and model to publish.
     */
    @Column(name = "model", length = 200)
    private String model;

    /**
     * Year the instrument was made (e.g. "1965", "circa 1972").
     * Synced from Shopify metafield {@code custom.reverb_year}.
     * Forwarded to Reverb as {@code year}.
     */
    @Column(name = "year_made", length = 20)
    private String yearMade;

    /**
     * Instrument finish / colour (e.g. "Sunburst", "Olympic White").
     * Synced from Shopify metafield {@code custom.reverb_finish}.
     * Forwarded to Reverb as {@code finish}.
     */
    @Column(name = "finish", length = 100)
    private String finish;

    /**
     * Free-text notes describing the specific condition of this item
     * (e.g. "Small crack in headstock, repaired. No impact on playability.").
     * Synced from Shopify metafield {@code custom.condition_notes}.
     * Forwarded to Reverb as {@code condition_description}.
     */
    @Column(name = "condition_notes", length = 1000)
    private String conditionNotes;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    @Builder.Default
    private ProductStatus status = ProductStatus.ACTIVE;

    /**
     * Optimistic locking — prevents inventory oversell race conditions.
     */
    @Version
    private Long version;
}
