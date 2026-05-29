package com.gearline.api.orders;

import com.gearline.api.ResourceNotFoundException;
import com.gearline.domain.order.Order;
import com.gearline.domain.order.OrderStatus;
import com.gearline.infrastructure.persistence.OrderRepository;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.*;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.UUID;

@RestController
@RequestMapping("/api/v1/orders")
@RequiredArgsConstructor
@Tag(name = "Orders", description = "Marketplace order imports")
public class OrderController {

    private final OrderRepository orderRepository;

    @GetMapping
    @Operation(summary = "List imported orders")
    public ResponseEntity<Page<OrderDto>> listOrders(
        @RequestParam(defaultValue = "0") int page,
        @RequestParam(defaultValue = "50") int size,
        @RequestParam(required = false) OrderStatus status
    ) {
        Pageable pageable = PageRequest.of(page, Math.min(size, 200), Sort.by(Sort.Direction.DESC, "importedAt"));
        Page<Order> orders = status != null
            ? orderRepository.findByOrderStatus(status, pageable)
            : orderRepository.findAll(pageable);
        return ResponseEntity.ok(orders.map(OrderDto::from));
    }

    @GetMapping("/{id}")
    @Operation(summary = "Get an order by ID")
    public ResponseEntity<OrderDto> getOrder(@PathVariable UUID id) {
        return ResponseEntity.ok(OrderDto.from(
            orderRepository.findById(id).orElseThrow(() -> new ResourceNotFoundException("Order", id))
        ));
    }
}
