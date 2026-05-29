package com.gearline.api.admin;

import com.gearline.domain.user.User;
import com.gearline.domain.user.UserRole;

import java.time.Instant;
import java.util.UUID;

public record UserDto(
    UUID id,
    String email,
    String firstName,
    String lastName,
    UserRole role,
    Boolean active,
    Instant lastLoginAt,
    Instant createdAt
) {
    public static UserDto from(User u) {
        return new UserDto(
            u.getId(), u.getEmail(),
            u.getFirstName(), u.getLastName(),
            u.getRole(), u.getActive(),
            u.getLastLoginAt(), u.getCreatedAt()
        );
    }
}
