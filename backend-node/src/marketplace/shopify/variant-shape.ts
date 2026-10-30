import type { VariantOptionJson } from '../../db/types.js';

/**
 * What a Shopify variant IS, beyond its fields: its option values, its
 * position, and its own photo. Variant groups (services/variant-groups.ts) need
 * all three, and both ingestion paths — the webhook processor and the manual
 * resync — read them through here so they cannot disagree.
 *
 * Works on the REST product shape that webhooks and /products/{id}.json share:
 *
 *   product.options  [{ name: "Size", position: 1 }, { name: "Color", ... }]
 *   variant.option1  "Large"   (option2, option3 follow options[] order)
 *   variant.image_id 123       → product.images[].id
 */

type Json = Record<string, unknown>;

export interface VariantShape {
  variant_options: VariantOptionJson[];
  variant_position: number | null;
  variant_image_url: string | null;
}

function text(node: unknown, key: string): string {
  if (typeof node !== 'object' || node === null) return '';
  const value = (node as Json)[key];
  return value === null || value === undefined ? '' : String(value);
}

function list(node: unknown, key: string): unknown[] {
  if (typeof node !== 'object' || node === null) return [];
  const value = (node as Json)[key];
  return Array.isArray(value) ? value : [];
}

/** Option names in position order. A product with no real options has "Title". */
export function optionNames(product: Json): string[] {
  return list(product, 'options')
    .map((o, i) => ({ name: text(o, 'name').trim(), position: Number(text(o, 'position')) || i + 1 }))
    .sort((a, b) => a.position - b.position)
    .map((o) => o.name);
}

export function variantShape(product: Json, variant: Json): VariantShape {
  const names = optionNames(product);
  const options: VariantOptionJson[] = [];

  names.forEach((name, i) => {
    const value = text(variant, `option${i + 1}`).trim();
    // Shopify's implicit option on a product without options — not a real choice.
    if (name === '' || value === '' || (name === 'Title' && value === 'Default Title')) return;
    options.push({ name, value });
  });

  const position = Number(text(variant, 'position'));

  const imageId = text(variant, 'image_id');
  let imageUrl: string | null = null;
  if (imageId !== '' && imageId !== 'null') {
    const image = list(product, 'images').find((img) => text(img, 'id') === imageId);
    const src = image ? text(image, 'src') : '';
    if (src !== '') imageUrl = src;
  }

  return {
    variant_options: options,
    variant_position: Number.isInteger(position) && position > 0 ? position : null,
    variant_image_url: imageUrl,
  };
}
