package com.gearline.api.auth;

import com.gearline.domain.user.User;

public record UserProfileResponse(
    String id,
    String email,
    String firstName,
    String lastName,
    String role
) {
    public static UserProfileResponse from(User user) {
        return new UserProfileResponse(
            user.getId().toString(),
            user.getEmail(),
            user.getFirstName(),
            user.getLastName(),
            user.getRole().name()
        );
    }
}
