package com.gearline.api.listings;

import com.gearline.api.ResourceNotFoundException;
import com.gearline.domain.listing.ListingStatus;
import com.gearline.domain.listing.MarketplaceListing;
import com.gearline.domain.sync.SyncJob;
import com.gearline.domain.sync.SyncJobType;
import com.gearline.domain.user.User;
import com.gearline.infrastructure.persistence.MarketplaceListingRepository;
import com.gearline.infrastructure.messaging.SyncJobProducer;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.*;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/listings")
@RequiredArgsConstructor
@Tag(name = "Listings", description = "Marketplace listing management")
public class ListingController {

    private final MarketplaceListingRepository listingRepository;
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
        return ResponseEntity.ok(listings.map(ListingDto::from));
    }

    @GetMapping("/{id}")
    @Operation(summary = "Get a listing by ID")
    public ResponseEntity<ListingDto> getListing(@PathVariable UUID id) {
        return ResponseEntity.ok(ListingDto.from(
            listingRepository.findById(id).orElseThrow(() -> new ResourceNotFoundException("Listing", id))
        ));
    }

    @GetMapping("/product/{productId}")
    @Operation(summary = "Get all listings for a product")
    public ResponseEntity<List<ListingDto>> getListingsForProduct(@PathVariable UUID productId) {
        return ResponseEntity.ok(listingRepository.findByProductId(productId)
            .stream().map(ListingDto::from).toList());
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

        return ResponseEntity.ok(ListingDto.from(listingRepository.save(listing)));
    }
}
