package com.gearline.api.products;

import com.gearline.api.ResourceNotFoundException;
import com.gearline.domain.product.Product;
import com.gearline.domain.product.ProductStatus;
import com.gearline.infrastructure.persistence.ProductRepository;
import com.gearline.marketplace.shopify.ShopifyResyncService;
import com.gearline.service.AuditService;
import com.gearline.service.ProductExclusionService;
import com.gearline.domain.audit.AuditEventType;
import com.gearline.domain.user.User;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.persistence.criteria.Predicate;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.*;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;
import java.io.PrintWriter;
import java.net.URI;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/products")
@RequiredArgsConstructor
@Tag(name = "Products", description = "Canonical product catalog management")
public class ProductController {

    private final ProductRepository productRepository;
    private final AuditService auditService;
    private final ProductExclusionService productExclusionService;
    private final ShopifyResyncService shopifyResyncService;

    private static final Set<String> SORTABLE_FIELDS = Set.of(
        "sku", "title", "brand", "price", "quantity", "status", "createdAt", "updatedAt"
    );

    @GetMapping
    @Operation(summary = "List all products with pagination and optional search/status/exclusion/sort filter")
    public ResponseEntity<Page<ProductDto>> listProducts(
        @RequestParam(defaultValue = "0") int page,
        @RequestParam(defaultValue = "50") int size,
        @RequestParam(required = false) ProductStatus status,
        @RequestParam(required = false) String search,
        @RequestParam(required = false) Boolean marketplaceExcluded,
        @RequestParam(defaultValue = "createdAt") String sortBy,
        @RequestParam(defaultValue = "desc") String sortDir
    ) {
        String field = SORTABLE_FIELDS.contains(sortBy) ? sortBy : "createdAt";
        Sort.Direction dir = "asc".equalsIgnoreCase(sortDir) ? Sort.Direction.ASC : Sort.Direction.DESC;
        Pageable pageable = PageRequest.of(page, Math.min(size, 500), Sort.by(dir, field));
        Specification<Product> spec = buildSpec(status, search, marketplaceExcluded);
        Page<Product> products = productRepository.findAll(spec, pageable);
        return ResponseEntity.ok(products.map(ProductDto::from));
    }

    /**
     * Streams all products as a CSV file for offline audit (e.g. SKU / title reconciliation).
     * Returns at most 10 000 rows to keep response times reasonable.
     */
    @GetMapping("/export.csv")
    @Operation(summary = "Export all products as CSV for offline audit")
    public void exportCsv(HttpServletResponse response) throws IOException {
        response.setContentType("text/csv; charset=UTF-8");
        response.setHeader("Content-Disposition",
            "attachment; filename=\"gearline-products-" + LocalDate.now() + ".csv\"");

        List<Product> all = productRepository.findAll(Sort.by(Sort.Direction.ASC, "sku"));

        try (PrintWriter w = response.getWriter()) {
            w.println("SKU,Title,Brand,Category,Model,Year,Condition,Price,Quantity,Status,MarketplaceExcluded,ShopifyProductId");
            for (Product p : all) {
                w.printf("%s,%s,%s,%s,%s,%s,%s,%s,%d,%s,%s,%s%n",
                    csvField(p.getSku()),
                    csvField(p.getTitle()),
                    csvField(p.getBrand()),
                    csvField(p.getCategory()),
                    csvField(p.getModel()),
                    csvField(p.getYearMade()),
                    csvField(p.getCondition() != null ? p.getCondition().name() : ""),
                    p.getPrice(),
                    p.getQuantity(),
                    p.getStatus().name(),
                    p.isMarketplaceExcluded(),
                    csvField(p.getShopifyProductId()));
            }
        }
    }

    /** Wraps a CSV field value in quotes if it contains commas, quotes, or newlines. */
    private static String csvField(String s) {
        if (s == null) return "";
        if (s.contains(",") || s.contains("\"") || s.contains("\n") || s.contains("\r")) {
            return "\"" + s.replace("\"", "\"\"") + "\"";
        }
        return s;
    }

    /**
     * Builds a JPA Specification combining optional status, full-text search,
     * and marketplace exclusion filter.
     */
    private Specification<Product> buildSpec(ProductStatus status, String search, Boolean marketplaceExcluded) {
        return (root, query, cb) -> {
            List<Predicate> predicates = new ArrayList<>();
            if (status != null) {
                predicates.add(cb.equal(root.get("status"), status));
            }
            if (marketplaceExcluded != null) {
                predicates.add(cb.equal(root.get("marketplaceExcluded"), marketplaceExcluded));
            }
            if (search != null && !search.isBlank()) {
                String pattern = "%" + search.toLowerCase() + "%";
                predicates.add(cb.or(
                    cb.like(cb.lower(root.get("title")),  pattern),
                    cb.like(cb.lower(root.get("sku")),    pattern),
                    cb.like(cb.lower(root.get("brand")),  pattern)
                ));
            }
            return predicates.isEmpty() ? cb.conjunction() : cb.and(predicates.toArray(new Predicate[0]));
        };
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

        if (request.sku() != null && !request.sku().isBlank() && !request.sku().equals(product.getSku())) {
            if (productRepository.existsBySku(request.sku())) {
                throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.CONFLICT,
                    "SKU already in use: " + request.sku()
                );
            }
            product.setSku(request.sku().strip());
        }
        if (request.title() != null) product.setTitle(request.title());
        if (request.description() != null) product.setDescription(request.description());
        if (request.brand() != null) product.setBrand(request.brand());
        if (request.category() != null) product.setCategory(request.category());
        if (request.condition() != null) product.setCondition(request.condition());
        if (request.price() != null) product.setPrice(request.price());
        if (request.quantity() != null) product.setQuantity(request.quantity());
        if (request.imageUrls() != null) product.setImageUrls(request.imageUrls());
        if (request.videoUrl() != null) product.setVideoUrl(request.videoUrl().isBlank() ? null : request.videoUrl());

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

    /**
     * Re-syncs a single product's mutable fields (including SKU) from the Shopify
     * Admin API, correcting drift that occurs when webhooks fail silently.
     *
     * Does NOT create or modify marketplace listings — it only updates the product
     * record itself. Returns the updated product alongside a human-readable message
     * describing what changed (or a clear error if a SKU collision is detected).
     */
    @PostMapping("/{id}/resync-from-shopify")
    @Operation(summary = "Pull latest product fields from Shopify to correct drift or SKU mismatches")
    public ResponseEntity<Map<String, Object>> resyncFromShopify(
        @PathVariable UUID id,
        @AuthenticationPrincipal User currentUser
    ) {
        ShopifyResyncService.ResyncResult result = shopifyResyncService.resync(id);

        if (!result.success()) {
            int status = result.isConflict() ? 409 : 400;
            var body = new java.util.LinkedHashMap<String, Object>();
            body.put("error",                result.message());
            body.put("conflict",             result.isConflict());
            body.put("shopifySku",           result.shopifySku() != null ? result.shopifySku() : "");
            body.put("conflictProductId",    result.conflictProductId() != null ? result.conflictProductId() : "");
            body.put("conflictProductTitle", result.conflictProductTitle() != null ? result.conflictProductTitle() : "");
            return ResponseEntity.status(status).body(body);
        }

        Product updated = productRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("Product", id));

        auditService.record(AuditEventType.PRODUCT_UPDATED,
            currentUser.getId(), "Product", id.toString(), true, null,
            Map.of("source", "shopify-resync",
                   "skuChanged", String.valueOf(result.skuChanged()),
                   "oldSku", result.oldSku() != null ? result.oldSku() : ""));

        var body = new java.util.LinkedHashMap<String, Object>();
        body.put("product",    ProductDto.from(updated));
        body.put("skuChanged", result.skuChanged());
        body.put("shopifySku", result.shopifySku() != null ? result.shopifySku() : "");
        body.put("oldSku",     result.oldSku()     != null ? result.oldSku()     : "");
        body.put("newSku",     result.newSku()     != null ? result.newSku()     : "");
        body.put("message",    result.message());
        return ResponseEntity.ok(body);
    }

    /**
     * Sets or clears the marketplace_excluded flag for a single product.
     *
     * When excluded=true:
     *   - All NEEDS_REVIEW/PENDING/FAILED listing stubs are deleted immediately.
     *   - Any ACTIVE marketplace listings get a LISTING_DELIST job queued.
     *   - Future Shopify webhooks will not create new listing stubs.
     *
     * When excluded=false:
     *   - The flag is cleared. The product will re-enter the review queue
     *     on the next Shopify webhook or manual sync.
     */
    @PatchMapping("/{id}/marketplace-excluded")
    @Operation(summary = "Exclude or include a product from all marketplace channels")
    public ResponseEntity<ProductDto> setMarketplaceExcluded(
        @PathVariable UUID id,
        @RequestBody MarketplaceExcludedRequest req,
        @AuthenticationPrincipal User currentUser
    ) {
        Product updated = productExclusionService.setExcluded(id, req.excluded());

        auditService.record(
            req.excluded() ? AuditEventType.PRODUCT_UPDATED : AuditEventType.PRODUCT_UPDATED,
            currentUser.getId(), "Product", id.toString(), true, null,
            Map.of("marketplaceExcluded", String.valueOf(req.excluded()))
        );

        return ResponseEntity.ok(ProductDto.from(updated));
    }

    /**
     * Bulk-reconciles all product SKUs against the current Shopify catalog.
     *
     * Solves the "swapped SKU" problem that per-product resync cannot: when SKUs
     * are swapped between products, individual resyncs fail with collision errors.
     * This endpoint resolves all collisions atomically by temporarily moving
     * conflicting SKUs to RESYNC-TEMP-{uuid} values before applying the correct ones.
     *
     * This does NOT create or modify marketplace listings — only product fields.
     *
     * Returns a summary: how many products were compared, how many needed updates,
     * how many were successfully updated, and any errors.
     */
    @PostMapping("/bulk-resync-skus-from-shopify")
    @Operation(summary = "Reconcile all SKUs against Shopify in one atomic operation")
    public ResponseEntity<ShopifyResyncService.BulkResyncResult> bulkResyncSkus(
        @AuthenticationPrincipal User currentUser
    ) {
        ShopifyResyncService.BulkResyncResult result = shopifyResyncService.bulkResyncSkus();

        if (result.updated() > 0) {
            auditService.record(AuditEventType.PRODUCT_UPDATED,
                currentUser.getId(), "Product", "bulk", true, null,
                Map.of("source", "bulk-shopify-sku-resync", "updated", String.valueOf(result.updated())));
        }

        int status = result.success() ? 200 : (result.updated() > 0 ? 207 : 500);
        return ResponseEntity.status(status).body(result);
    }

    /**
     * Sets or clears the marketplace_excluded flag for multiple products at once.
     * Returns the count of products updated.
     *
     * Typical use: bulk-exclude hundreds of deposit listings in one click.
     */
    @PostMapping("/bulk-marketplace-excluded")
    @Operation(summary = "Bulk exclude or include products from all marketplace channels")
    public ResponseEntity<Map<String, Object>> bulkSetMarketplaceExcluded(
        @RequestBody BulkMarketplaceExcludedRequest req,
        @AuthenticationPrincipal User currentUser
    ) {
        if (req.productIds() == null || req.productIds().isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "productIds must not be empty"));
        }
        if (req.productIds().size() > 500) {
            return ResponseEntity.badRequest().body(Map.of("error", "Cannot update more than 500 products at once"));
        }

        int count = productExclusionService.bulkSetExcluded(req.productIds(), req.excluded());

        auditService.record(AuditEventType.PRODUCT_UPDATED,
            currentUser.getId(), "Product", "bulk", true, null,
            Map.of("marketplaceExcluded", String.valueOf(req.excluded()), "count", String.valueOf(count))
        );

        return ResponseEntity.ok(Map.of("updated", count, "excluded", req.excluded()));
    }

    // ── Request records ────────────────────────────────────────────────────────

    public record MarketplaceExcludedRequest(boolean excluded) {}

    public record BulkMarketplaceExcludedRequest(List<UUID> productIds, boolean excluded) {}
}
