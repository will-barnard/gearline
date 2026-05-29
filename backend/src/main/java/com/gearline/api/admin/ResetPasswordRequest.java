package com.gearline.api.admin;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record ResetPasswordRequest(
    @NotBlank @Size(min = 8, message = "Password must be at least 8 characters") String password
) {}
