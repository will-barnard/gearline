package com.gearline.api.products;

import com.gearline.api.ResourceNotFoundException;
import com.gearline.domain.product.Product;
import com.gearline.domain.product.ProductStatus;
import com.gearline.infrastructure.persistence.ProductRepository;
import com.gearline.service.AuditService;
import com.gearline.domain.audit.AuditEventType;
import com.gearline.domain.user.User;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.*;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.net.URI;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/products")
@RequiredArgsConstructor
@Tag(name = "Products", description = "Canonical product catalog management")
public class ProductController {

    private final ProductRepository productRepository;
    private final AuditService auditService;

    @GetMapping
    @Operation(summary = "List all products with pagination")
    public ResponseEntity<Page<ProductDto>> listProducts(
        @RequestParam(defaultValue = "0") int page,
        @RequestParam(defaultValue = "50") int size,
        @RequestParam(required = false) ProductStatus status,
        @RequestParam(required = false) String search
    ) {
        Pageable pageable = PageRequest.of(page, Math.min(size, 200), Sort.by(Sort.Direction.DESC, "createdAt"));
        Page<Product> products = status != null
            ? productRepository.findByStatus(status, pageable)
            : productRepository.findAll(pageable);
        return ResponseEntity.ok(products.map(ProductDto::from));
    }

    @GetMapping("/{id}")
    @Operation(summary = "Get a product by ID")
    public ResponseEntity<ProductDto> getProduct(@PathVariable UUID id) {
        Product product = productRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("Product", id));
        return ResponseEntity.ok(ProductDto.from(product));
    }

    @PostMapping
    @Operation(summary = "Create a new product")
    public ResponseEntity<ProductDto> createProduct(
        @Valid @RequestBody CreateProductRequest request,
        @AuthenticationPrincipal User currentUser
    ) {
        if (productRepository.existsBySku(request.sku())) {
            throw new org.springframework.web.server.ResponseStatusException(
                org.springframework.http.HttpStatus.CONFLICT, "SKU already exists: " + request.sku()
            );
        }

        Product product = Product.builder()
            .sku(request.sku())
            .title(request.title())
            .description(request.description())
            .brand(request.brand())
            .category(request.category())
            .condition(request.condition())
            .price(request.price())
            .quantity(request.quantity() != null ? request.quantity() : 0)
            .weightKg(request.weightKg())
            .serialNumber(request.serialNumber())
            .imageUrls(request.imageUrls() != null ? request.imageUrls() : java.util.List.of())
            .status(ProductStatus.ACTIVE)
            .build();

        Product saved = productRepository.save(product);

        auditService.record(AuditEventType.PRODUCT_CREATED,
            currentUser.getId(), "Product", saved.getId().toString(), true, null,
            Map.of("sku", saved.getSku()));

        return ResponseEntity.created(URI.create("/api/v1/products/" + saved.getId()))
            .body(ProductDto.from(saved));
    }

    @PutMapping("/{id}")
    @Operation(summary = "Update a product")
    public ResponseEntity<ProductDto> updateProduct(
        @PathVariable UUID id,
        @Valid @RequestBody UpdateProductRequest request,
        @AuthenticationPrincipal User currentUser
    ) {
        Product product = productRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("Product", id));

        if (request.title() != null) product.setTitle(request.title());
        if (request.description() != null) product.setDescription(request.description());
        if (request.brand() != null) product.setBrand(request.brand());
        if (request.category() != null) product.setCategory(request.category());
        if (request.condition() != null) product.setCondition(request.condition());
        if (request.price() != null) product.setPrice(request.price());
        if (request.quantity() != null) product.setQuantity(request.quantity());
        if (request.imageUrls() != null) product.setImageUrls(request.imageUrls());

        Product saved = productRepository.save(product);

        auditService.record(AuditEventType.PRODUCT_UPDATED,
            currentUser.getId(), "Product", id.toString(), true, null,
            Map.of("sku", product.getSku()));

        return ResponseEntity.ok(ProductDto.from(saved));
    }

    @DeleteMapping("/{id}")
    @Operation(summary = "Archive a product")
    public ResponseEntity<Void> archiveProduct(
        @PathVariable UUID id,
        @AuthenticationPrincipal User currentUser
    ) {
        Product product = productRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("Product", id));
        product.setStatus(ProductStatus.ARCHIVED);
        productRepository.save(product);

        auditService.record(AuditEventType.PRODUCT_ARCHIVED,
            currentUser.getId(), "Product", id.toString(), true, null, Map.of());

        return ResponseEntity.noContent().build();
    }
}
