package com.gearline.infrastructure.persistence;

import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.marketplace.common.connector.MarketplaceType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface MarketplaceAccountRepository extends JpaRepository<MarketplaceAccount, UUID> {
    List<MarketplaceAccount> findByActiveTrue();
    List<MarketplaceAccount> findByMarketplaceType(MarketplaceType type);
    List<MarketplaceAccount> findByMarketplaceTypeAndActiveTrue(MarketplaceType type);
    Optional<MarketplaceAccount> findByExternalAccountId(String externalAccountId);

    /**
     * Updates only the {@code lastSyncAt} field for a marketplace account by ID,
     * bypassing Hibernate's {@code @Version} optimistic-lock check.
     *
     * Why this is needed: the scheduler loads an account, then the auth provider may
     * refresh the token mid-poll (saving the account, bumping @Version). When the
     * scheduler then tries to save the same account entity to advance lastSyncAt, it
     * sees a stale version and throws ObjectOptimisticLockingFailureException.
     *
     * A targeted UPDATE avoids loading the entity and sidesteps the version check
     * entirely — lastSyncAt is ours to write; the auth provider owns credentials.
     */
    @Modifying
    @Transactional
    @Query("UPDATE MarketplaceAccount a SET a.lastSyncAt = :lastSyncAt WHERE a.id = :id")
    void updateLastSyncAt(@Param("id") UUID id, @Param("lastSyncAt") Instant lastSyncAt);
}
