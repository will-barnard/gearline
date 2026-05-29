package com.gearline.domain.marketplace;

import com.gearline.domain.audit.AuditableEntity;
import com.gearline.marketplace.common.connector.MarketplaceType;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

@Entity
@Table(name = "marketplace_accounts", indexes = {
    @Index(name = "idx_marketplace_accounts_type", columnList = "marketplace_type"),
    @Index(name = "idx_marketplace_accounts_external_id", columnList = "external_account_id")
})
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
@EqualsAndHashCode(of = "id", callSuper = false)
public class MarketplaceAccount extends AuditableEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(nullable = false, updatable = false)
    private UUID id;

    @Enumerated(EnumType.STRING)
    @Column(name = "marketplace_type", nullable = false, length = 30)
    private MarketplaceType marketplaceType;

    @Column(nullable = false, length = 200)
    private String displayName;

    /** External shop/account identifier from the marketplace */
    @Column(name = "external_account_id", length = 200)
    private String externalAccountId;

    @Column(name = "external_shop_url", length = 500)
    private String externalShopUrl;

    /**
     * Encrypted OAuth credentials stored as JSON.
     * Contains: access_token, refresh_token, token_expiry, scope.
     * Encryption handled at the service layer before persistence.
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "encrypted_credentials", columnDefinition = "jsonb")
    private Map<String, String> encryptedCredentials;

    /**
     * Sync configuration (polling intervals, feature flags, etc.)
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "sync_settings", columnDefinition = "jsonb")
    @Builder.Default
    private Map<String, Object> syncSettings = new HashMap<>();

    @Column(nullable = false)
    @Builder.Default
    private Boolean active = true;

    @Column(name = "last_sync_at")
    private Instant lastSyncAt;

    @Column(name = "last_error", columnDefinition = "TEXT")
    private String lastError;

    @Enumerated(EnumType.STRING)
    @Column(name = "connection_status", nullable = false, length = 20)
    @Builder.Default
    private ConnectionStatus connectionStatus = ConnectionStatus.DISCONNECTED;

    @Version
    private Long version;
}
