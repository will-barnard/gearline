import { describe, expect, it } from 'vitest';

import type { MarketplaceAccountRow } from '../src/db/types.js';
import { toMarketplaceAccountDto } from '../src/dto/mappers.js';

// Only the fields the mapper reads matter here; the rest of the row is irrelevant.
const account = (syncSettings: Record<string, unknown> | null) =>
  ({
    id: 'a1',
    marketplace_type: 'SHOPIFY',
    display_name: 'shop',
    sync_settings: syncSettings,
  }) as unknown as MarketplaceAccountRow;

describe('toMarketplaceAccountDto specialOrderTags', () => {
  it('reports the default tag when the setting was never saved', () => {
    expect(toMarketplaceAccountDto(account(null)).specialOrderTags).toEqual(['special-order']);
    expect(toMarketplaceAccountDto(account({})).specialOrderTags).toEqual(['special-order']);
  });

  it('reports the saved tags', () => {
    const dto = toMarketplaceAccountDto(
      account({ special_order_tags: ['special-order', 'always-available'] }),
    );
    expect(dto.specialOrderTags).toEqual(['special-order', 'always-available']);
  });

  it('reports an empty list (feature off) as empty, not as the default', () => {
    expect(toMarketplaceAccountDto(account({ special_order_tags: [] })).specialOrderTags).toEqual([]);
  });
});
