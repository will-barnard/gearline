package com.gearline.api.admin;

import com.gearline.domain.user.UserRole;

public record UpdateUserRequest(
    String firstName,
    String lastName,
    UserRole role,
    Boolean active
) {}
