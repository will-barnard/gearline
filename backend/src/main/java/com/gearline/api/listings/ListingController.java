package com.gearline.api.listings;

import com.gearline.api.ResourceNotFoundException;
import com.gearline.domain.listing.ListingStatus;
import com.gearline.domain.listing.MarketplaceListing;
import com.gearline.domain.marketplace.MarketplaceAccount;
import com.gearline.domain.product.Product;
import com.gearline.domain.sync.SyncJob;
import com.gearline.domain.sync.SyncJobType;
import com.gearline.domain.user.User;
import com.gearline.infrastructure.persistence.MarketplaceAccountRepository;
import com.gearline.infrastructure.persistence.MarketplaceListingRepository;
import com.gearline.infrastructure.persistence.ProductRepository;
import com.gearline.infrastructure.messaging.SyncJobProducer;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.*;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.net.URI;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/v1/listings")
@RequiredArgsConstructor
@Tag(name = "Listings", description = "Marketplace listing management")
public class ListingController {

    private final MarketplaceListingRepository listingRepository;
    private final MarketplaceAccountRepository accountRepository;
    private final ProductRepository productRepository;
    private final SyncJobProducer syncJobProducer;

    @GetMapping
    @Operation(summary = "List marketplace listings with optional status filter")
    public ResponseEntity<Page<ListingDto>> listListings(
        @RequestParam(defaultValue = "0") int page,
        @RequestParam(defaultValue = "50") int size,
        @RequestParam(required = false) ListingStatus status
    ) {
        Pageable pageable = PageRequest.of(page, Math.min(size, 200), Sort.by(Sort.Direction.DESC, "createdAt"));
        Page<MarketplaceListing> listings = status != null
            ? listingRepository.findByListingStatus(status, pageable)
            : listingRepository.findAll(pageable);

        Map<UUID, Product> productMap = fetchProductMap(
            listings.stream().map(MarketplaceListing::getProductId).collect(Collectors.toSet()));

        return ResponseEntity.ok(listings.map(l -> ListingDto.from(l, productMap.get(l.getProductId()))));
    }

    @GetMapping("/{id}")
    @Operation(summary = "Get a listing by ID")
    public ResponseEntity<ListingDto> getListing(@PathVariable UUID id) {
        MarketplaceListing listing = listingRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("Listing", id));
        Product product = productRepository.findById(listing.getProductId()).orElse(null);
        return ResponseEntity.ok(ListingDto.from(listing, product));
    }

    @GetMapping("/product/{productId}")
    @Operation(summary = "Get all listings for a product")
    public ResponseEntity<List<ListingDto>> getListingsForProduct(@PathVariable UUID productId) {
        Product product = productRepository.findById(productId).orElse(null);
        return ResponseEntity.ok(listingRepository.findByProductId(productId)
            .stream().map(l -> ListingDto.from(l, product)).toList());
    }

    @PostMapping
    @Operation(summary = "Create a new listing record for a product on a marketplace account")
    public ResponseEntity<ListingDto> createListing(
        @Valid @RequestBody CreateListingRequest request
    ) {
        Product product = productRepository.findById(request.productId())
            .orElseThrow(() -> new ResourceNotFoundException("Product", request.productId()));

        MarketplaceAccount account = accountRepository.findById(request.marketplaceAccountId())
            .orElseThrow(() -> new ResourceNotFoundException("MarketplaceAccount", request.marketplaceAccountId()));

        // Prevent duplicate listings for the same product+account combination
        if (listingRepository.findByProductIdAndMarketplaceAccountId(
                product.getId(), account.getId()).isPresent()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "A listing already exists for this product on that marketplace account");
        }

        MarketplaceListing listing = MarketplaceListing.builder()
            .productId(product.getId())
            .marketplaceAccountId(account.getId())
            .marketplaceType(account.getMarketplaceType())
            .listingStatus(ListingStatus.PENDING)
            .build();

        if (request.overrides() != null) {
            listing.getListingOverrides().putAll(request.overrides());
        }

        MarketplaceListing saved = listingRepository.save(listing);
        return ResponseEntity
            .created(URI.create("/api/v1/listings/" + saved.getId()))
            .body(ListingDto.from(saved));
    }

    @PostMapping("/{id}/publish")
    @Operation(summary = "Enqueue a listing for publishing to its marketplace")
    public ResponseEntity<Void> publishListing(
        @PathVariable UUID id,
        @AuthenticationPrincipal User currentUser
    ) {
        MarketplaceListing listing = listingRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("Listing", id));

        SyncJob job = SyncJob.builder()
            .jobType(SyncJobType.LISTING_PUBLISH)
            .marketplaceType(listing.getMarketplaceType())
            .marketplaceAccountId(listing.getMarketplaceAccountId())
            .productId(listing.getProductId())
            .listingId(listing.getId())
            .build();

        syncJobProducer.enqueue(job);
        return ResponseEntity.accepted().build();
    }

    @PostMapping("/{id}/delist")
    @Operation(summary = "Enqueue a listing for removal from its marketplace")
    public ResponseEntity<Void> delistListing(
        @PathVariable UUID id,
        @AuthenticationPrincipal User currentUser
    ) {
        MarketplaceListing listing = listingRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("Listing", id));

        SyncJob job = SyncJob.builder()
            .jobType(SyncJobType.LISTING_DELIST)
            .marketplaceType(listing.getMarketplaceType())
            .marketplaceAccountId(listing.getMarketplaceAccountId())
            .productId(listing.getProductId())
            .listingId(listing.getId())
            .build();

        syncJobProducer.enqueue(job);
        return ResponseEntity.accepted().build();
    }

    @DeleteMapping("/{id}")
    @Operation(summary = "Dismiss a listing — sets it to INACTIVE without touching the marketplace. " +
        "Use for NEEDS_REVIEW listings you have decided not to publish, or to clean up stale records.")
    public ResponseEntity<Void> dismissListing(
        @PathVariable UUID id,
        @AuthenticationPrincipal User currentUser
    ) {
        MarketplaceListing listing = listingRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("Listing", id));

        // Only allow dismissing listings that haven't been published — if the listing
        // is ACTIVE on a marketplace, the user must Delist it first so the marketplace
        // record is properly removed before we mark it inactive here.
        if (listing.getListingStatus() == ListingStatus.ACTIVE) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                "Cannot dismiss an ACTIVE listing — delist it from the marketplace first.");
        }

        listing.setListingStatus(ListingStatus.INACTIVE);
        listingRepository.save(listing);
        return ResponseEntity.noContent().build();
    }

    @PatchMapping("/{id}/overrides")
    @Operation(summary = "Update marketplace-specific overrides for a listing")
    public ResponseEntity<ListingDto> updateOverrides(
        @PathVariable UUID id,
        @Valid @RequestBody UpdateListingOverridesRequest request
    ) {
        MarketplaceListing listing = listingRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("Listing", id));

        if (request.overrides() != null) {
            listing.getListingOverrides().putAll(request.overrides());
        }

        MarketplaceListing saved = listingRepository.save(listing);
        Product product = productRepository.findById(saved.getProductId()).orElse(null);
        return ResponseEntity.ok(ListingDto.from(saved, product));
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    /** Batch-fetches products by ID and returns them keyed by UUID. */
    private Map<UUID, Product> fetchProductMap(Set<UUID> productIds) {
        if (productIds.isEmpty()) return Map.of();
        return productRepository.findAllById(productIds)
            .stream()
            .collect(Collectors.toMap(Product::getId, p -> p));
    }
}
