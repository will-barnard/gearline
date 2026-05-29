package com.gearline.domain.listing;

import com.gearline.domain.audit.AuditableEntity;
import com.gearline.marketplace.common.connector.MarketplaceType;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

@Entity
@Table(name = "marketplace_listings", indexes = {
    @Index(name = "idx_listings_product_id", columnList = "product_id"),
    @Index(name = "idx_listings_account_id", columnList = "marketplace_account_id"),
    @Index(name = "idx_listings_external_id", columnList = "external_listing_id"),
    @Index(name = "idx_listings_status", columnList = "listing_status"),
    @Index(name = "idx_listings_type_external", columnList = "marketplace_type, external_listing_id")
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
@EqualsAndHashCode(of = "id", callSuper = false)
public class MarketplaceListing extends AuditableEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(nullable = false, updatable = false)
    private UUID id;

    @Column(name = "product_id", nullable = false)
    private UUID productId;

    @Column(name = "marketplace_account_id", nullable = false)
    private UUID marketplaceAccountId;

    @Enumerated(EnumType.STRING)
    @Column(name = "marketplace_type", nullable = false, length = 30)
    private MarketplaceType marketplaceType;

    /** The listing ID on the external marketplace */
    @Column(name = "external_listing_id", length = 200)
    private String externalListingId;

    @Enumerated(EnumType.STRING)
    @Column(name = "listing_status", nullable = false, length = 30)
    @Builder.Default
    private ListingStatus listingStatus = ListingStatus.PENDING;

    /** Price as last synced to this marketplace (may differ from canonical product price) */
    @Column(name = "synced_price", precision = 10, scale = 2)
    private BigDecimal syncedPrice;

    /** Quantity as last synced to this marketplace */
    @Column(name = "synced_quantity")
    private Integer syncedQuantity;

    @Column(name = "last_sync_at")
    private Instant lastSyncAt;

    @Column(name = "last_error", columnDefinition = "TEXT")
    private String lastError;

    @Column(name = "error_count")
    @Builder.Default
    private Integer errorCount = 0;

    /**
     * Marketplace-specific overrides for this listing.
     * E.g.: custom title, description, category mappings, shipping options.
     * This is where marketplace-specific data lives — NOT on Product.
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "listing_overrides", columnDefinition = "jsonb")
    @Builder.Default
    private Map<String, Object> listingOverrides = new HashMap<>();

    /**
     * Opaque marketplace-specific metadata returned by the external API.
     * E.g.: Reverb listing URL, eBay item specifics, etc.
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "marketplace_metadata", columnDefinition = "jsonb")
    @Builder.Default
    private Map<String, Object> marketplaceMetadata = new HashMap<>();

    @Version
    private Long version;
}
