import { describe, expect, it } from 'vitest';

import { reverbProviderFor } from '../src/marketplace/reverb/client.js';

describe('reverbProviderFor', () => {
  it('maps Shopify carrier names onto Reverb providers', () => {
    expect(reverbProviderFor('UPS')).toBe('UPS');
    expect(reverbProviderFor('USPS')).toBe('USPS');
    expect(reverbProviderFor('United States Postal Service')).toBe('USPS');
    expect(reverbProviderFor('FedEx Ground')).toBe('FedEx');
    expect(reverbProviderFor('DHL Express')).toBe('DHL');
    expect(reverbProviderFor('Canada Post')).toBe('Canada Post');
  });

  it('does not mistake USPS for UPS', () => {
    expect(reverbProviderFor('usps priority')).toBe('USPS');
  });

  it('falls back to Other', () => {
    expect(reverbProviderFor(null)).toBe('Other');
    expect(reverbProviderFor('')).toBe('Other');
    expect(reverbProviderFor('Local courier')).toBe('Other');
  });
});
