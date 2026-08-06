import type { NextFunction, Request, Response } from 'express';

import { db } from '../db/index.js';
import type { UserRole } from '../db/types.js';
import { ApiError } from '../http/errors.js';
import { loggerFor } from '../logger.js';
import { extractUserId, isAccessToken, validateAndExtractClaims } from './jwt.js';

const log = loggerFor('auth');

export interface AuthenticatedUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: UserRole;
  active: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

const BEARER_PREFIX = 'Bearer ';

/**
 * Populates req.user from a Bearer token, mirroring JwtAuthenticationFilter.
 *
 * Deliberately non-rejecting: a missing or invalid token leaves req.user unset
 * and continues down the chain. Enforcement is `requireAuth`'s job. This split
 * reproduces Spring's filter-then-authorize ordering and is what lets the
 * public routes (webhooks, OAuth callbacks) sit on the same app without
 * special-casing them here.
 *
 * Like the Java filter it re-reads the user on every request rather than
 * trusting the role baked into the token. Tokens live for two years; without
 * the re-read, deactivating a user or demoting an admin would not take effect
 * until their token expired.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.header('authorization');

  if (!header || !header.startsWith(BEARER_PREFIX)) {
    next();
    return;
  }

  const token = header.slice(BEARER_PREFIX.length);

  try {
    const claims = await validateAndExtractClaims(token);

    // Refresh tokens must not authenticate API calls — they are only accepted
    // by POST /auth/refresh.
    if (!isAccessToken(claims)) {
      next();
      return;
    }

    const user = await db
      .selectFrom('users')
      .select(['id', 'email', 'first_name', 'last_name', 'role', 'active'])
      .where('id', '=', extractUserId(claims))
      .executeTakeFirst();

    if (user?.active) {
      req.user = {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        active: user.active,
      };
    }
  } catch (err) {
    log.debug({ err, path: req.path }, 'JWT authentication failed');
    // Fall through unauthenticated — requireAuth will produce the 401.
  }

  next();
}

/**
 * Rejects unauthenticated requests with 401.
 *
 * 401 rather than 403 is load-bearing: the frontend's axios interceptor only
 * attempts a token refresh on 401. Returning 403 would leave users stuck at a
 * dead page instead of silently re-authenticating. Spring needed a custom
 * AuthenticationEntryPoint to get this right; here it is just the default.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(new ApiError(401, 'Unauthorized', 'Full authentication is required to access this resource'));
    return;
  }
  next();
}

/**
 * Rejects users lacking any of the given roles with 403.
 * Mirrors @PreAuthorize("hasRole('ADMIN')") and the SecurityConfig matchers.
 */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new ApiError(401, 'Unauthorized', 'Full authentication is required to access this resource'));
      return;
    }

    if (!roles.includes(req.user.role)) {
      next(
        new ApiError(
          403,
          'Access denied',
          `Requires one of the following roles: ${roles.join(', ')}`,
        ),
      );
      return;
    }

    next();
  };
}

/**
 * Enforces `.requestMatchers(HttpMethod.DELETE, "/api/v1/**").hasRole("ADMIN")`.
 *
 * This rule is easy to lose in a rewrite because it is expressed once in
 * SecurityConfig rather than on each controller: EVERY DELETE under /api/v1 is
 * admin-only, including ones whose own handler has no role annotation (dismiss
 * a listing, archive a product, delete a pricing profile). Dropping it would
 * silently let operators and viewers delete data.
 */
export function requireAdminForDelete(req: Request, _res: Response, next: NextFunction): void {
  if (req.method !== 'DELETE') {
    next();
    return;
  }

  if (!req.user) {
    next(new ApiError(401, 'Unauthorized', 'Full authentication is required to access this resource'));
    return;
  }

  if (req.user.role !== 'ADMIN') {
    next(new ApiError(403, 'Access denied', 'DELETE operations require the ADMIN role'));
    return;
  }

  next();
}

/** Convenience accessor for handlers that run behind requireAuth. */
export function currentUser(req: Request): AuthenticatedUser {
  if (!req.user) {
    throw new ApiError(401, 'Unauthorized', 'No authenticated user on request');
  }
  return req.user;
}
