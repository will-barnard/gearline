-- Seed default admin user
-- Password: GearlineAdmin1! (BCrypt hash — change immediately in production)
INSERT INTO users (id, email, password_hash, first_name, last_name, role, active)
VALUES (
    gen_random_uuid(),
    'admin@gearline.io',
    '$2a$12$K.rJPHTmJwvyBIwm/gu.NuFAqNY0M.D7jRY/oGf6j.Sj7TYiIOKvy',
    'Gearline',
    'Admin',
    'ADMIN',
    TRUE
) ON CONFLICT (email) DO NOTHING;
