package com.gearline.api.admin;

import com.gearline.api.ResourceNotFoundException;
import com.gearline.domain.user.User;
import com.gearline.infrastructure.persistence.UserRepository;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.UUID;

/**
 * Admin-only user management endpoints.
 *
 * All routes require ADMIN role — enforced both by SecurityConfig
 * (/api/v1/admin/** → ADMIN) and the @PreAuthorize annotation for clarity.
 */
@RestController
@RequestMapping("/api/v1/admin/users")
@RequiredArgsConstructor
@PreAuthorize("hasRole('ADMIN')")
@Tag(name = "Users", description = "User account management (admin only)")
public class UserController {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;

    @GetMapping
    @Operation(summary = "List all user accounts")
    public ResponseEntity<List<UserDto>> listUsers() {
        return ResponseEntity.ok(
            userRepository.findAll().stream().map(UserDto::from).toList()
        );
    }

    @GetMapping("/{id}")
    @Operation(summary = "Get a user by ID")
    public ResponseEntity<UserDto> getUser(@PathVariable UUID id) {
        return ResponseEntity.ok(UserDto.from(requireUser(id)));
    }

    @PostMapping
    @Operation(summary = "Create a new user account")
    public ResponseEntity<UserDto> createUser(@Valid @RequestBody CreateUserRequest request) {
        if (userRepository.findByEmail(request.email()).isPresent()) {
            return ResponseEntity.status(409).build(); // Conflict — email already exists
        }

        User user = User.builder()
            .email(request.email())
            .passwordHash(passwordEncoder.encode(request.password()))
            .firstName(request.firstName() != null ? request.firstName() : "")
            .lastName(request.lastName() != null ? request.lastName() : "")
            .role(request.role())
            .active(true)
            .build();

        return ResponseEntity.status(201).body(UserDto.from(userRepository.save(user)));
    }

    @PatchMapping("/{id}")
    @Operation(summary = "Update a user's name, role, or active status")
    public ResponseEntity<UserDto> updateUser(
        @PathVariable UUID id,
        @RequestBody UpdateUserRequest request
    ) {
        User user = requireUser(id);

        if (request.firstName() != null) user.setFirstName(request.firstName());
        if (request.lastName()  != null) user.setLastName(request.lastName());
        if (request.role()      != null) user.setRole(request.role());
        if (request.active()    != null) user.setActive(request.active());

        return ResponseEntity.ok(UserDto.from(userRepository.save(user)));
    }

    @PostMapping("/{id}/reset-password")
    @Operation(summary = "Reset a user's password (admin sets new password)")
    public ResponseEntity<Void> resetPassword(
        @PathVariable UUID id,
        @Valid @RequestBody ResetPasswordRequest request
    ) {
        User user = requireUser(id);
        user.setPasswordHash(passwordEncoder.encode(request.password()));
        userRepository.save(user);
        return ResponseEntity.noContent().build();
    }

    @DeleteMapping("/{id}")
    @Operation(summary = "Deactivate (soft-delete) a user account")
    public ResponseEntity<Void> deactivateUser(@PathVariable UUID id) {
        User user = requireUser(id);
        user.setActive(false);
        userRepository.save(user);
        return ResponseEntity.noContent().build();
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    private User requireUser(UUID id) {
        return userRepository.findById(id)
            .orElseThrow(() -> new ResourceNotFoundException("User", id));
    }
}
