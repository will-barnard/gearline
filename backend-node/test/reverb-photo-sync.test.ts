import { describe, expect, it } from 'vitest';

import { needsPhotoReplace, planPhotoReplace, reverbPhotos } from '../src/marketplace/reverb/photo-sync.js';

const urls = (n: number, prefix = 'a') => Array.from({ length: n }, (_, i) => `https://cdn.example/${prefix}${i}.jpg`);

describe('needsPhotoReplace', () => {
  const sent = urls(3);

  it('leaves a listing alone when the photos have not changed', () => {
    expect(needsPhotoReplace({ photo_sources: sent }, [...sent], true)).toBe(false);
  });

  it('replaces photos Gearline sent when they change', () => {
    expect(needsPhotoReplace({ photo_sources: sent }, urls(2), false)).toBe(true);
  });

  it('treats a reorder as a change', () => {
    expect(needsPhotoReplace({ photo_sources: sent }, [...sent].reverse(), false)).toBe(true);
  });

  it('leaves listings published before tracking alone unless pushed', () => {
    expect(needsPhotoReplace({}, urls(2), false)).toBe(false);
    expect(needsPhotoReplace(null, urls(2), true)).toBe(true);
  });

  it('never strips a listing to no photos', () => {
    expect(needsPhotoReplace({ photo_sources: sent }, [], true)).toBe(false);
  });
});

describe('planPhotoReplace', () => {
  it('adds first and deletes after when there is room', () => {
    expect(planPhotoReplace(['1', '2', '3'], 4)).toEqual({ deleteBefore: [], deleteAfter: ['1', '2', '3'] });
  });

  it('deletes just enough first to stay under 25', () => {
    const current = Array.from({ length: 20 }, (_, i) => String(i));
    const plan = planPhotoReplace(current, 10);
    expect(plan.deleteBefore).toHaveLength(5);
    expect([...plan.deleteBefore, ...plan.deleteAfter]).toEqual(current);
  });
});

describe('reverbPhotos', () => {
  it('drops non-http URLs and caps at 25', () => {
    expect(reverbPhotos(['data:x', ...urls(30)])).toEqual(urls(25));
  });
});
