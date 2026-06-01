package com.gearline.infrastructure.persistence;

import com.gearline.domain.pricing.PricingProfile;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.UUID;

@Repository
public interface PricingProfileRepository extends JpaRepository<PricingProfile, UUID> {
    List<PricingProfile> findAllByActiveTrue();
}
