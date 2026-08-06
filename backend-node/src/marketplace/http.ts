import { request } from 'undici';

import { loggerFor } from '../logger.js';
import { PermanentMarketplaceError, RetryableMarketplaceError } from './types.js';

const log = loggerFor('marketplace-http');

/**
 * Shared HTTP helper for all marketplace API clients.
 *
 * Replaces Spring's WebClient. The important behaviour it centralises is the
 * retryable/permanent split, because getting that wrong is expensive in both
 * directions:
 *
 *   - Treating a 400 as retryable burns five attempts and delays the operator
 *     seeing that their listing payload is malformed.
 *   - Treating a 429 or 503 as permanent dead-letters a job that would have
 *     succeeded seconds later.
 *
 * Classification:
 *   408, 429, 5xx, network errors -> RetryableMarketplaceError
 *   other 4xx                     -> PermanentMarketplaceError
 */

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface ApiRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  accessToken?: string;
  headers?: Record<string, string>;
  /** JSON body. Mutually exclusive with `form`. */
  json?: unknown;
  /** application/x-www-form-urlencoded body, used by OAuth token endpoints. */
  form?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number;
  /** Marketplace name, for error messages. */
  marketplace: string;
  /**
   * Populates `headers` on the response.
   *
   * Needed for Shopify's cursor pagination, which returns the next-page cursor
   * in a `Link` header rather than the body. Off by default so the common case
   * does not carry the extra object around.
   */
  includeResponseHeaders?: boolean;
}

export interface ApiResponse<T> {
  status: number;
  body: T;
  rawBody: string;
  /** Only populated when `includeResponseHeaders` was set. */
  headers?: Record<string, string | string[] | undefined>;
}

function buildUrl(url: string, query?: ApiRequestOptions['query']): string {
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }

  const qs = params.toString();
  if (qs === '') return url;
  return url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`;
}

/**
 * Performs a request and parses the JSON response.
 *
 * A 404 is NOT special-cased here — callers that treat "already gone" as
 * success (delist) must catch PermanentMarketplaceError and inspect statusCode.
 * Swallowing 404s globally would hide genuine "listing does not exist" bugs on
 * update and inventory paths.
 */
export async function apiRequest<T = unknown>(opts: ApiRequestOptions): Promise<ApiResponse<T>> {
  const url = buildUrl(opts.url, opts.query);

  const headers: Record<string, string> = {
    accept: 'application/json',
    ...opts.headers,
  };

  if (opts.accessToken) headers['authorization'] = `Bearer ${opts.accessToken}`;

  let body: string | undefined;

  if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }

  let response;

  try {
    response = await request(url, {
      method: opts.method,
      headers,
      body,
      headersTimeout: opts.timeoutMs ?? 30_000,
      bodyTimeout: opts.timeoutMs ?? 30_000,
    });
  } catch (err) {
    // Connection refused, DNS failure, timeout — all transient by nature.
    throw new RetryableMarketplaceError(
      `${opts.marketplace} request failed (${opts.method} ${url}): ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  const rawBody = await response.body.text();
  const status = response.statusCode;

  if (status >= 400) {
    // Truncate: marketplace error bodies can be enormous HTML pages, and this
    // string lands in sync_jobs.failure_reason and the audit log.
    const snippet = rawBody.slice(0, 500);
    const message = `${opts.marketplace} API error (HTTP ${status}) on ${opts.method} ${url}: ${snippet}`;

    if (RETRYABLE_STATUSES.has(status)) {
      log.warn({ status, url, marketplace: opts.marketplace }, 'Retryable marketplace API error');
      throw new RetryableMarketplaceError(message, status);
    }

    log.error({ status, url, marketplace: opts.marketplace }, 'Permanent marketplace API error');
    throw new PermanentMarketplaceError(message, status);
  }

  const responseHeaders = opts.includeResponseHeaders ? response.headers : undefined;

  // 204 and empty bodies are legitimate for delist/inventory calls.
  if (rawBody.trim() === '') {
    return { status, body: null as T, rawBody, headers: responseHeaders };
  }

  try {
    return { status, body: JSON.parse(rawBody) as T, rawBody, headers: responseHeaders };
  } catch {
    throw new PermanentMarketplaceError(
      `${opts.marketplace} returned a non-JSON body (HTTP ${status}): ${rawBody.slice(0, 200)}`,
      status,
    );
  }
}

/** True when the error is a permanent 404 — "already gone". */
export function isNotFound(err: unknown): boolean {
  return err instanceof PermanentMarketplaceError && err.statusCode === 404;
}
