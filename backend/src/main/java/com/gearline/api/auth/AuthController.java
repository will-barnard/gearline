package com.gearline.api.auth;

import com.gearline.domain.audit.AuditEventType;
import com.gearline.domain.user.User;
import com.gearline.infrastructure.persistence.UserRepository;
import com.gearline.infrastructure.security.JwtTokenService;
import com.gearline.service.AuditService;
import io.jsonwebtoken.Claims;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/auth")
@RequiredArgsConstructor
@Slf4j
@Tag(name = "Auth", description = "Authentication and token management")
public class AuthController {

    private final UserRepository userRepository;
    private final JwtTokenService jwtTokenService;
    private final PasswordEncoder passwordEncoder;
    private final AuditService auditService;

    @PostMapping("/login")
    @Operation(summary = "Authenticate with email and password, receive JWT tokens")
    public ResponseEntity<LoginResponse> login(@Valid @RequestBody LoginRequest request) {
        User user = userRepository.findByEmail(request.email())
            .orElseThrow(() -> new InvalidCredentialsException("Invalid email or password"));

        if (!user.getActive()) {
            throw new InvalidCredentialsException("Account is disabled");
        }

        if (!passwordEncoder.matches(request.password(), user.getPasswordHash())) {
            throw new InvalidCredentialsException("Invalid email or password");
        }

        user.setLastLoginAt(Instant.now());
        userRepository.save(user);

        String accessToken = jwtTokenService.generateAccessToken(user);
        String refreshToken = jwtTokenService.generateRefreshToken(user);

        auditService.record(AuditEventType.USER_LOGIN, user.getId(), "User", user.getId().toString(), true, null, Map.of());

        return ResponseEntity.ok(LoginResponse.of(accessToken, refreshToken, user));
    }

    @PostMapping("/refresh")
    @Operation(summary = "Exchange a refresh token for a new access token")
    public ResponseEntity<Map<String, String>> refresh(@RequestBody Map<String, String> body) {
        String refreshToken = body.get("refreshToken");
        if (refreshToken == null || refreshToken.isBlank()) {
            return ResponseEntity.badRequest().build();
        }

        Claims claims = jwtTokenService.validateAndExtractClaims(refreshToken);
        if (!jwtTokenService.isRefreshToken(claims)) {
            return ResponseEntity.status(401).build();
        }

        var userId = jwtTokenService.extractUserId(claims);
        User user = userRepository.findById(userId)
            .filter(User::getActive)
            .orElseThrow(() -> new InvalidCredentialsException("User not found or inactive"));

        String newAccessToken = jwtTokenService.generateAccessToken(user);
        auditService.record(AuditEventType.TOKEN_REFRESHED, user.getId(), "User", user.getId().toString(), true, null, Map.of());

        return ResponseEntity.ok(Map.of("accessToken", newAccessToken));
    }

    @GetMapping("/me")
    @Operation(summary = "Get the currently authenticated user profile")
    public ResponseEntity<UserProfileResponse> me(
        @org.springframework.security.core.annotation.AuthenticationPrincipal User user
    ) {
        return ResponseEntity.ok(UserProfileResponse.from(user));
    }
}
