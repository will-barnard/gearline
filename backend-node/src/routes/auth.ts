import { Router, type ErrorRequestHandler } from 'express';
import { z } from 'zod';

import { db } from '../db/index.js';
import { toUserProfileResponse } from '../dto/mappers.js';
import { ApiError, asyncHandler, InvalidCredentialsError } from '../http/errors.js';
import {
  extractUserId,
  generateAccessToken,
  generateRefreshToken,
  isRefreshToken,
  validateAndExtractClaims,
} from '../security/jwt.js';
import { verifyPassword } from '../security/password.js';
import { currentUser, requireAuth } from '../security/auth-middleware.js';
import * as audit from '../services/audit.js';

/** Port of AuthController. Mounted at /api/v1/auth. */
export const authRouter: Router = Router();

const loginSchema = z.object({
  email: z.string().min(1, 'must not be blank').email('must be a well-formed email address'),
  password: z.string().min(1, 'must not be blank'),
});

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);

    const user = await db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', email)
      .executeTakeFirst();

    /**
     * Uniform failure handling below is deliberate. "No such user", "wrong
     * password" and "disabled account" must be indistinguishable to an
     * unauthenticated caller, otherwise the endpoint becomes an account
     * enumeration oracle. The Java version had the same property.
     *
     * We still run a bcrypt comparison against a dummy hash when the user does
     * not exist, so the response time does not leak existence either.
     */
    if (!user) {
      await verifyPassword(password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
      throw new InvalidCredentialsError();
    }

    if (!user.active) {
      throw new InvalidCredentialsError('Account is disabled');
    }

    if (!(await verifyPassword(password, user.password_hash))) {
      throw new InvalidCredentialsError();
    }

    await db
      .updateTable('users')
      .set({ last_login_at: new Date() })
      .where('id', '=', user.id)
      .execute();

    const subject = { id: user.id, email: user.email, role: user.role };
    const [accessToken, refreshToken] = await Promise.all([
      generateAccessToken(subject),
      generateRefreshToken(subject),
    ]);

    audit.record({
      type: 'USER_LOGIN',
      actorId: user.id,
      entityType: 'User',
      entityId: user.id,
    });

    res.json({
      accessToken,
      refreshToken,
      userId: user.id,
      email: user.email,
      role: user.role,
    });
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const refreshToken = (req.body as { refreshToken?: unknown })?.refreshToken;

    if (typeof refreshToken !== 'string' || refreshToken.trim() === '') {
      // Java returned a bare 400 with no body here.
      res.status(400).end();
      return;
    }

    const claims = await validateAndExtractClaims(refreshToken);

    if (!isRefreshToken(claims)) {
      res.status(401).end();
      return;
    }

    const user = await db
      .selectFrom('users')
      .select(['id', 'email', 'role', 'active'])
      .where('id', '=', extractUserId(claims))
      .executeTakeFirst();

    if (!user?.active) {
      throw new InvalidCredentialsError('User not found or inactive');
    }

    const accessToken = await generateAccessToken({
      id: user.id,
      email: user.email,
      role: user.role,
    });

    audit.record({
      type: 'TOKEN_REFRESHED',
      actorId: user.id,
      entityType: 'User',
      entityId: user.id,
    });

    res.json({ accessToken });
  }),
);

/**
 * /me sits behind requireAuth even though SecurityConfig marks /api/v1/auth/**
 * as permitAll. In Java, @AuthenticationPrincipal simply yielded null for an
 * anonymous caller and the handler NPE'd into a 500. Returning a clean 401 is
 * the correct behaviour and is what the frontend's interceptor expects.
 */
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(toUserProfileResponse(currentUser(req)));
  }),
);

authRouter.all(
  '/logout',
  asyncHandler(async (req, res) => {
    // Tokens are stateless and long-lived; there is nothing server-side to
    // invalidate. The frontend clears localStorage. Recorded for the audit trail.
    if (req.user) {
      audit.record({
        type: 'USER_LOGOUT',
        actorId: req.user.id,
        entityType: 'User',
        entityId: req.user.id,
      });
    }
    res.status(204).end();
  }),
);

/**
 * Turns a malformed JSON body into a clean 400 instead of a 500.
 *
 * express.json() throws a SyntaxError on unparseable input, which would
 * otherwise fall through to the generic handler. Login is the endpoint most
 * likely to be hit by a hand-rolled client, so it is worth the specific message.
 *
 * Must be typed as a 4-argument ErrorRequestHandler — Express identifies error
 * middleware by arity, and the parameters cannot be `never` or the overload
 * does not match.
 */
const malformedBodyHandler: ErrorRequestHandler = (err, _req, _res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    next(new ApiError(400, 'Malformed request body', 'Request body is not valid JSON'));
    return;
  }
  next(err);
};

authRouter.use(malformedBodyHandler);
