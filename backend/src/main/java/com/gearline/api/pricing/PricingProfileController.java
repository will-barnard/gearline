package com.gearline.api.pricing;

import com.gearline.api.ResourceNotFoundException;
import com.gearline.domain.pricing.PricingProfile;
import com.gearline.infrastructure.persistence.PricingProfileRepository;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.net.URI;
import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/pricing-profiles")
@RequiredArgsConstructor
@Tag(name = "Pricing Profiles", description = "Per-marketplace price adjustment rules")
public class PricingProfileController {

    private final PricingProfileRepository repository;

    @GetMapping
    @Operation(summary = "List all pricing profiles")
    public ResponseEntity<List<PricingProfileDto>> list() {
        return ResponseEntity.ok(repository.findAll().stream().map(PricingProfileDto::from).toList());
    }

    @GetMapping("/{id}")
    @Operation(summary = "Get a pricing profile by ID")
    public ResponseEntity<PricingProfileDto> get(@PathVariable UUID id) {
        return ResponseEntity.ok(PricingProfileDto.from(
            repository.findById(id).orElseThrow(() -> new ResourceNotFoundException("PricingProfile", id))
        ));
    }

    @PostMapping
    @Operation(summary = "Create a new pricing profile")
    public ResponseEntity<PricingProfileDto> create(@Valid @RequestBody CreatePricingProfileRequest req) {
        PricingProfile profile = repository.save(PricingProfile.builder()
            .name(req.name())
            .adjustmentPercent(req.adjustmentPercent())
            .build());
        return ResponseEntity.created(URI.create("/api/v1/pricing-profiles/" + profile.getId()))
            .body(PricingProfileDto.from(profile));
    }

    @PutMapping("/{id}")
    @Operation(summary = "Update a pricing profile")
    public ResponseEntity<PricingProfileDto> update(
        @PathVariable UUID id,
        @Valid @RequestBody UpdatePricingProfileRequest req
    ) {
        PricingProfile profile = repository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("PricingProfile", id));
        if (req.name() != null) profile.setName(req.name());
        if (req.adjustmentPercent() != null) profile.setAdjustmentPercent(req.adjustmentPercent());
        if (req.active() != null) profile.setActive(req.active());
        return ResponseEntity.ok(PricingProfileDto.from(repository.save(profile)));
    }

    @DeleteMapping("/{id}")
    @Operation(summary = "Delete a pricing profile")
    public ResponseEntity<Void> delete(@PathVariable UUID id) {
        if (!repository.existsById(id)) {
            throw new ResourceNotFoundException("PricingProfile", id);
        }
        repository.deleteById(id);
        return ResponseEntity.noContent().build();
    }
}
