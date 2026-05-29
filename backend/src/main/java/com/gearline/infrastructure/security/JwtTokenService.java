package com.gearline.infrastructure.security;

import com.gearline.config.GearlineProperties;
import com.gearline.domain.user.User;
import io.jsonwebtoken.*;
import io.jsonwebtoken.io.Decoders;
import io.jsonwebtoken.security.Keys;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.util.Date;
import java.util.Map;
import java.util.UUID;

@Service
@RequiredArgsConstructor
@Slf4j
public class JwtTokenService {

    private final GearlineProperties properties;

    public String generateAccessToken(User user) {
        return buildToken(user, properties.getJwt().getAccessTokenExpiryMs(), "access");
    }

    public String generateRefreshToken(User user) {
        return buildToken(user, properties.getJwt().getRefreshTokenExpiryMs(), "refresh");
    }

    private String buildToken(User user, long expiryMs, String tokenType) {
        long now = System.currentTimeMillis();
        return Jwts.builder()
            .id(UUID.randomUUID().toString())
            .subject(user.getId().toString())
            .issuedAt(new Date(now))
            .expiration(new Date(now + expiryMs))
            .claims(Map.of(
                "email", user.getEmail(),
                "role", user.getRole().name(),
                "type", tokenType
            ))
            .signWith(signingKey())
            .compact();
    }

    public Claims validateAndExtractClaims(String token) {
        return Jwts.parser()
            .verifyWith(signingKey())
            .build()
            .parseSignedClaims(token)
            .getPayload();
    }

    public boolean isAccessToken(Claims claims) {
        return "access".equals(claims.get("type", String.class));
    }

    public boolean isRefreshToken(Claims claims) {
        return "refresh".equals(claims.get("type", String.class));
    }

    public UUID extractUserId(Claims claims) {
        return UUID.fromString(claims.getSubject());
    }

    public boolean isTokenValid(String token) {
        try {
            validateAndExtractClaims(token);
            return true;
        } catch (JwtException | IllegalArgumentException e) {
            log.debug("JWT validation failed: {}", e.getMessage());
            return false;
        }
    }

    private SecretKey signingKey() {
        byte[] keyBytes = Decoders.BASE64.decode(
            java.util.Base64.getEncoder().encodeToString(
                properties.getJwt().getSecret().getBytes()
            )
        );
        return Keys.hmacShaKeyFor(keyBytes);
    }
}
