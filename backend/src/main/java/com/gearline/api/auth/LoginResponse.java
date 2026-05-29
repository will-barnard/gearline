package com.gearline.api.auth;

import com.gearline.domain.user.User;

public record LoginResponse(
    String accessToken,
    String refreshToken,
    String userId,
    String email,
    String role
) {
    public static LoginResponse of(String accessToken, String refreshToken, User user) {
        return new LoginResponse(
            accessToken,
            refreshToken,
            user.getId().toString(),
            user.getEmail(),
            user.getRole().name()
        );
    }
}
