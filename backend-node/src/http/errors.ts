import type { NextFunction, Request, Response } from 'express';
import { errors as joseErrors } from 'jose';
import { ZodError } from 'zod';

import { loggerFor } from '../logger.js';

const log = loggerFor('errors');

/**
 * RFC 7807 ProblemDetail responses matching Spring's GlobalExceptionHandler.
 *
 * Spring serialises ProblemDetail as:
 *   { type, title, status, detail, ...custom properties }
 *
 * The frontend's axios interceptor keys off the HTTP status rather than the
 * body, but error text is surfaced in the UI, so we keep the same field names
 * and — importantly — the same status codes for the same failure modes.
 */

export interface ProblemDetailBody {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  [key: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly title: string;
  readonly type: string | undefined;
  readonly extra: Record<string, unknown>;

  constructor(
    status: number,
    title: string,
    detail?: string,
    opts: { type?: string; extra?: Record<string, unknown> } = {},
  ) {
    super(detail ?? title);
    this.name = 'ApiError';
    this.status = status;
    this.title = title;
    this.type = opts.type;
    this.extra = opts.extra ?? {};
  }
}

/** 404 — mirrors ResourceNotFoundException("Product", id). */
export class ResourceNotFoundError extends ApiError {
  constructor(resourceType: string, id: unknown) {
    super(404, 'Resource not found', `${resourceType} not found: ${String(id)}`);
    this.name = 'ResourceNotFoundError';
  }
}

/** 401 — mirrors InvalidCredentialsException. */
export class InvalidCredentialsError extends ApiError {
  constructor(detail = 'Invalid email or password') {
    super(401, 'Authentication failed', detail);
    this.name = 'InvalidCredentialsError';
  }
}

/** 409 — mirrors ResponseStatusException(CONFLICT, ...). */
export class ConflictError extends ApiError {
  constructor(detail: string) {
    super(409, detail, detail);
    this.name = 'ConflictError';
  }
}

/**
 * 409 — mirrors ObjectOptimisticLockingFailureException.
 *
 * Raised when an UPDATE guarded by a `version` predicate matches zero rows,
 * meaning another writer changed the row first. The client is expected to retry.
 */
export class OptimisticLockError extends ApiError {
  constructor() {
    super(
      409,
      'Concurrent modification conflict',
      'The resource was modified by another operation. Please retry.',
      { type: 'https://gearline.io/errors/conflict' },
    );
    this.name = 'OptimisticLockError';
  }
}

/** Postgres unique-violation / FK-violation SQLSTATEs we translate to 409. */
const PG_INTEGRITY_CODES = new Set(['23505', '23503', '23514']);

function isPgError(err: unknown): err is { code: string; constraint?: string } {
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string';
}

/**
 * Terminal error handler. Must be registered last, after all routes.
 *
 * Anything that reaches here uncaught becomes a 500 with a deliberately vague
 * body — the Java handler did the same, so internal messages and stack traces
 * are never leaked to the client. The full error still goes to the log.
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    // Streaming responses (the CSV export) may fail mid-flight. There is no way
    // to send a status at this point; hand back to Express to destroy the socket.
    next(err);
    return;
  }

  // ── Explicitly modelled application errors ───────────────────────────────
  if (err instanceof ApiError) {
    const body: ProblemDetailBody = {
      title: err.title,
      status: err.status,
      detail: err.message,
      ...err.extra,
    };
    if (err.type) body.type = err.type;

    // 5xx from our own code is still a bug worth logging loudly.
    if (err.status >= 500) log.error({ err, path: req.path }, 'Application error');
    else log.debug({ err: err.message, status: err.status, path: req.path }, 'Request rejected');

    res.status(err.status).json(body);
    return;
  }

  // ── Request body validation — mirrors MethodArgumentNotValidException ─────
  if (err instanceof ZodError) {
    const errors: Record<string, string> = {};
    for (const issue of err.errors) {
      errors[issue.path.join('.') || '_'] = issue.message;
    }

    res.status(422).json({
      type: 'https://gearline.io/errors/validation',
      title: 'Validation failed',
      status: 422,
      errors,
      timestamp: new Date().toISOString(),
    } satisfies ProblemDetailBody);
    return;
  }

  // ── JWT failures — mirrors the JwtException handler ───────────────────────
  if (err instanceof joseErrors.JOSEError) {
    res.status(401).json({
      title: 'Invalid or expired token',
      status: 401,
      detail: 'Token validation failed',
    } satisfies ProblemDetailBody);
    return;
  }

  // ── Database integrity — mirrors DataIntegrityViolationException ──────────
  if (isPgError(err) && PG_INTEGRITY_CODES.has(err.code)) {
    log.warn({ code: err.code, constraint: err.constraint, path: req.path }, 'Integrity violation');
    res.status(409).json({
      title: 'Data integrity violation',
      status: 409,
      detail: 'A resource with these values already exists.',
    } satisfies ProblemDetailBody);
    return;
  }

  // ── Anything else ─────────────────────────────────────────────────────────
  log.error({ err, path: req.path, method: req.method }, 'Unhandled exception');

  res.status(500).json({
    title: 'Internal server error',
    status: 500,
    detail: 'An unexpected error occurred. Please contact support if this persists.',
    timestamp: new Date().toISOString(),
  } satisfies ProblemDetailBody);
}

/**
 * Wraps an async route handler so a rejected promise reaches errorHandler.
 *
 * Express 4 does not await handlers, so without this an async throw becomes an
 * unhandled rejection and the request hangs until the client times out. Express 5
 * fixes this natively; until we are on it, every async handler goes through here.
 */
export function asyncHandler<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void fn(req as T, res, next).catch(next);
  };
}

/** 404 fallback for unmatched routes. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    title: 'Resource not found',
    status: 404,
    detail: `No handler for ${req.method} ${req.path}`,
  } satisfies ProblemDetailBody);
}
