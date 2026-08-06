/**
 * Spring Data `Page<T>` JSON compatibility.
 *
 * The Vue frontend reads `content`, `totalElements`, `totalPages`, `number`,
 * `size`, `first`, `last` and `empty` straight off the response body. Those
 * field names come from Spring Data's Page serialization, so the Node service
 * has to reproduce the same envelope or every paginated table in the UI breaks.
 *
 * This is intentionally a faithful copy of Spring's shape including the fields
 * the frontend does not currently read (`pageable`, `sort`, `numberOfElements`).
 * Reproducing the whole envelope costs nothing and means a future frontend
 * change cannot quietly depend on a field we omitted.
 */

export interface SortDescriptor {
  sorted: boolean;
  unsorted: boolean;
  empty: boolean;
}

export interface PageableDescriptor {
  pageNumber: number;
  pageSize: number;
  sort: SortDescriptor;
  offset: number;
  paged: boolean;
  unpaged: boolean;
}

export interface Page<T> {
  content: T[];
  pageable: PageableDescriptor;
  totalElements: number;
  totalPages: number;
  last: boolean;
  size: number;
  number: number;
  sort: SortDescriptor;
  first: boolean;
  numberOfElements: number;
  empty: boolean;
}

export interface PageRequest {
  page: number;
  size: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

/**
 * Parses `page`/`size`/`sortBy`/`sortDir` query params the way Spring's
 * `@RequestParam(defaultValue = ...)` + `PageRequest.of(...)` did.
 *
 * `maxSize` mirrors the `Math.min(size, N)` clamps in the Java controllers —
 * 500 for products, 200 for everything else.
 */
export function parsePageRequest(
  query: Record<string, unknown>,
  opts: { defaultSize?: number; maxSize: number; defaultSortBy?: string } = { maxSize: 200 },
): Required<Pick<PageRequest, 'page' | 'size'>> & {
  sortBy: string;
  sortDir: 'asc' | 'desc';
} {
  const rawPage = Number.parseInt(String(query.page ?? '0'), 10);
  const rawSize = Number.parseInt(String(query.size ?? String(opts.defaultSize ?? 50)), 10);

  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 0;
  const sizeCandidate = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : (opts.defaultSize ?? 50);

  const sortDir = String(query.sortDir ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

  return {
    page,
    size: Math.min(sizeCandidate, opts.maxSize),
    sortBy: String(query.sortBy ?? opts.defaultSortBy ?? 'createdAt'),
    sortDir,
  };
}

const sortedDescriptor: SortDescriptor = { sorted: true, unsorted: false, empty: false };

/** Wraps a slice of rows plus a total count into Spring's Page envelope. */
export function toPage<T>(content: T[], total: number, page: number, size: number): Page<T> {
  const totalPages = size > 0 ? Math.ceil(total / size) : 0;

  return {
    content,
    pageable: {
      pageNumber: page,
      pageSize: size,
      sort: sortedDescriptor,
      offset: page * size,
      paged: true,
      unpaged: false,
    },
    totalElements: total,
    totalPages,
    last: page >= totalPages - 1,
    size,
    number: page,
    sort: sortedDescriptor,
    first: page === 0,
    numberOfElements: content.length,
    empty: content.length === 0,
  };
}
