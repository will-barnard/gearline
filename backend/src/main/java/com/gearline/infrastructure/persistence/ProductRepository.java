package com.gearline.infrastructure.persistence;

import com.gearline.domain.product.Product;
import com.gearline.domain.product.ProductStatus;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface ProductRepository extends JpaRepository<Product, UUID>, JpaSpecificationExecutor<Product> {

    Optional<Product> findBySku(String sku);
    Optional<Product> findByShopifyProductId(String shopifyProductId);
    Optional<Product> findByShopifyVariantId(String shopifyVariantId);

    boolean existsBySku(String sku);

    Page<Product> findByStatus(ProductStatus status, Pageable pageable);

    @Modifying
    @Query("UPDATE Product p SET p.quantity = :quantity WHERE p.id = :id")
    int updateQuantity(@Param("id") UUID id, @Param("quantity") int quantity);

    @Query("SELECT p FROM Product p WHERE p.status = 'ACTIVE' AND p.quantity > 0")
    Page<Product> findAvailableForListing(Pageable pageable);
}
