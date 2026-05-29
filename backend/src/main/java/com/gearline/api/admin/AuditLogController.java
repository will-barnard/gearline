package com.gearline.api.admin;

import com.gearline.domain.audit.AuditEvent;
import com.gearline.domain.audit.AuditEventType;
import com.gearline.infrastructure.persistence.AuditEventRepository;
import com.gearline.marketplace.common.connector.MarketplaceType;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.*;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/audit")
@RequiredArgsConstructor
@Tag(name = "Audit Logs", description = "Searchable audit event log")
public class AuditLogController {

    private final AuditEventRepository auditEventRepository;

    @GetMapping
    @Operation(summary = "List audit events with optional filters")
    public ResponseEntity<Page<AuditEventDto>> listEvents(
        @RequestParam(defaultValue = "0") int page,
        @RequestParam(defaultValue = "50") int size,
        @RequestParam(required = false) AuditEventType eventType,
        @RequestParam(required = false) MarketplaceType marketplaceType,
        @RequestParam(required = false) Boolean successOnly,
        @RequestParam(required = false) String from,
        @RequestParam(required = false) String to
    ) {
        Pageable pageable = PageRequest.of(page, Math.min(size, 200), Sort.by(Sort.Direction.DESC, "createdAt"));

        Page<AuditEvent> events;
        if (from != null && to != null) {
            events = auditEventRepository.findByCreatedAtBetween(Instant.parse(from), Instant.parse(to), pageable);
        } else if (eventType != null) {
            events = auditEventRepository.findByEventType(eventType, pageable);
        } else if (marketplaceType != null) {
            events = auditEventRepository.findByMarketplaceType(marketplaceType, pageable);
        } else if (Boolean.FALSE.equals(successOnly)) {
            events = auditEventRepository.findBySuccessFalse(pageable);
        } else {
            events = auditEventRepository.findAll(pageable);
        }

        return ResponseEntity.ok(events.map(AuditEventDto::from));
    }
}
