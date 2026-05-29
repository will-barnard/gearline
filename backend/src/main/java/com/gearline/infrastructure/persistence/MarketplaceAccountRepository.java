package com.gearline.infrastructure.persistence;

import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.marketplace.common.connector.MarketplaceType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface MarketplaceAccountRepository extends JpaRepository<MarketplaceAccount, UUID> {
    List<MarketplaceAccount> findByActiveTrue();
    List<MarketplaceAccount> findByMarketplaceType(MarketplaceType type);
    List<MarketplaceAccount> findByMarketplaceTypeAndActiveTrue(MarketplaceType type);
    Optional<MarketplaceAccount> findByExternalAccountId(String externalAccountId);
}
