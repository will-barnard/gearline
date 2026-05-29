package com.gearline.config;

import com.gearline.domain.user.User;
import com.gearline.domain.user.UserRole;
import com.gearline.infrastructure.persistence.UserRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Runs once at startup to ensure at least one admin account exists.
 *
 * Bootstrap behaviour (controlled by environment variables):
 *
 *   ADMIN_EMAIL     — email address for the bootstrap admin account
 *   ADMIN_PASSWORD  — plaintext password (hashed with BCrypt before storage)
 *
 * Rules:
 *   1. If ADMIN_EMAIL and ADMIN_PASSWORD are both set:
 *        - If a user with that email already exists, their password is updated
 *          and their role is promoted to ADMIN.  This lets you rotate the
 *          admin password by redeploying without touching the database.
 *        - If no user with that email exists, a new ADMIN account is created.
 *   2. If neither variable is set, no action is taken (the Flyway V8 seed
 *      user admin@gearline.io / GearlineAdmin1! remains as the fallback).
 *   3. If the users table is completely empty AND neither variable is set,
 *      a warning is logged — the app is unusable without at least one account.
 *
 * Recommended production workflow:
 *   Set ADMIN_EMAIL and ADMIN_PASSWORD in your Beachhead environment before
 *   the first deploy.  After logging in, create your personal account through
 *   the dashboard, then remove (or leave) the bootstrap variables — they are
 *   safe to leave set because they only upsert the one designated admin.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class DataInitializer implements ApplicationRunner {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        String adminEmail    = System.getenv("ADMIN_EMAIL");
        String adminPassword = System.getenv("ADMIN_PASSWORD");

        if (adminEmail != null && !adminEmail.isBlank()
                && adminPassword != null && !adminPassword.isBlank()) {

            String hash = passwordEncoder.encode(adminPassword);

            userRepository.findByEmail(adminEmail).ifPresentOrElse(
                existing -> {
                    // Update password and ensure ADMIN role on every startup when vars are set.
                    // Idempotent — safe to redeploy repeatedly.
                    existing.setPasswordHash(hash);
                    existing.setRole(UserRole.ADMIN);
                    existing.setActive(true);
                    userRepository.save(existing);
                    log.info("DataInitializer: updated admin account '{}'", adminEmail);
                },
                () -> {
                    User admin = User.builder()
                        .email(adminEmail)
                        .passwordHash(hash)
                        .firstName("Admin")
                        .lastName("")
                        .role(UserRole.ADMIN)
                        .active(true)
                        .build();
                    userRepository.save(admin);
                    log.info("DataInitializer: created admin account '{}'", adminEmail);
                }
            );

        } else {
            // No env vars — rely on Flyway seed; warn if the table is empty.
            long userCount = userRepository.count();
            if (userCount == 0) {
                log.warn("DataInitializer: no users found and ADMIN_EMAIL/ADMIN_PASSWORD are not set. " +
                    "The application has no accounts — set these environment variables and redeploy.");
            } else {
                log.debug("DataInitializer: {} user(s) found, no bootstrap action required", userCount);
            }
        }
    }
}
