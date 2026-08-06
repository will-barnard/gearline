import { applyPercentageAdjustment, setScaleHalfUp, parseDecimal, decimalToString, divideHalfUp }
  from './src/util/decimal.js';
import { calculateInsuranceValue, kgToOz } from './src/services/shipping-calculator.js';
import { mapCondition, toReverbRequest } from './src/marketplace/reverb/listing-mapper.js';
import { toImportedOrder } from './src/marketplace/reverb/order-mapper.js';
import { mapEbayCondition, buildInventoryItemBody, buildOfferBody }
  from './src/marketplace/ebay/listing-mapper.js';
import { map as mapEbayOrder } from './src/marketplace/ebay/order-mapper.js';

let fail = 0;
const eq = (n: string, g: unknown, w: unknown) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}${ok ? '' : `\n       got ${JSON.stringify(g)}\n      want ${JSON.stringify(w)}`}`);
};

console.log('--- decimal ---');
eq('2400.00 @ 15.5%', applyPercentageAdjustment('2400.00','15.5'), '2772.00');
eq('99.99 @ 33.3333%', applyPercentageAdjustment('99.99','33.3333'), '133.32');
eq('100.00 @ -12.5%', applyPercentageAdjustment('100.00','-12.5'), '87.50');
eq('HALF_UP neg', decimalToString(setScaleHalfUp(parseDecimal('-0.125'),2)), '-0.13');
eq('divideHalfUp 2/3', decimalToString(divideHalfUp(2n,3n,4)), '0.6667');

console.log('\n--- shipping ---');
eq('insurance 2400', calculateInsuranceValue('2400'), '3000');
eq('insurance 1000 stays', calculateInsuranceValue('1000'), '1000');
eq('kg->oz 3.5', kgToOz('3.5'), '123.459');
eq('kg->oz null', kgToOz(null), null);

console.log('\n--- reverb ---');
eq('condition FOR_PARTS', mapCondition('FOR_PARTS'), 'non-functioning');
eq('condition null', mapCondition(null), 'used');

const prod: any = { sku:'GTR-1', title:'Strat', description:'d', brand:'Fender',
  category:'Guitars', condition:'EXCELLENT', price:'2400.00', model:'Stratocaster',
  year_made:'1965', finish:'Sunburst', condition_notes:'notes', video_url:null,
  image_urls:['https://a.jpg'], quantity:1 };
const req: any = { titleOverride:null, descriptionOverride:null, priceOverride:null,
  quantity:2, imageUrls:['https://a.jpg'], categoryId:null, conditionMapping:null,
  shippingDetails:{ weightOz:'123.459', lengthIn:'48', widthIn:'18', heightIn:'6',
    shippingProfileName:null, insuranceValueUsd:'3000' }, extraParams:{} };
const rb: any = toReverbRequest(prod, req).listing;
eq('reverb inventory flat', rb.inventory, 2);
eq('reverb has_inventory', rb.has_inventory, true);
eq('reverb photos plain', rb.photos, ['https://a.jpg']);
eq('reverb price string', rb.price, { amount:'2400.00', currency:'USD' });
eq('reverb dimensions', rb.dimensions, { length:'48', width:'18', height:'6', unit:'in' });

const ro: any = toImportedOrder({ order_id: 25262223, buyer_name:'Mary Jane Watson',
  amount_product:{amount:'2400.00'}, amount_total:{amount:'2475.00'},
  _links:{web:{href:'https://reverb.com/my/selling/orders/25262223'}},
  listing:{id:'L1', sku:'GTR-1', title:'Strat'}, quantity:1, created_at:'2026-03-01T12:00:00Z' } as any);
eq('reverb order id -> string', ro.externalOrderId, '25262223');
eq('reverb name split', [ro.buyerInfo.firstName, ro.buyerInfo.lastName], ['Mary','Jane Watson']);
eq('reverb sku carried', ro.lineItems[0].sku, 'GTR-1');
eq('reverb bad date -> null', toImportedOrder({ ...({order_id:1, created_at:'nope'} as any) } as any)!.createdAt, null);

console.log('\n--- ebay ---');
eq('ebay VERY_GOOD prefixed', mapEbayCondition('VERY_GOOD'), 'USED_VERY_GOOD');
eq('ebay FAIR->ACCEPTABLE', mapEbayCondition('FAIR'), 'USED_ACCEPTABLE');
const inv: any = buildInventoryItemBody(prod, req);
eq('ebay aspects are arrays', inv.product.aspects.Brand, ['Fender']);
eq('ebay availability', inv.availability, { shipToLocationAvailability: { quantity: 2 } });
eq('ebay weight unit', inv.packageWeightAndSize.weight, { value:'123.459', unit:'OUNCE' });
eq('ebay packageType light', inv.packageWeightAndSize.packageType, 'MAILING_BOX');
const heavy: any = buildInventoryItemBody(prod,
  { ...req, shippingDetails: { ...req.shippingDetails, weightOz:'400' } });
eq('ebay packageType heavy', heavy.packageWeightAndSize.packageType, 'VERY_LARGE_PACKAGE');
const offer: any = buildOfferBody('GTR-1', prod, req);
eq('ebay offer price string', offer.pricingSummary.price, { value:'2400.00', currency:'USD' });
eq('ebay offer has no aspects', 'aspects' in offer, false);

const eo = mapEbayOrder({ orderId:'12-345', creationDate:'2026-03-01T00:00:00.000Z',
  buyer:{ username:'bob', buyerRegistrationAddress:{ fullName:'Bob Smith Jones', email:'b@e.com' } },
  lineItems:[{ lineItemId:'LI-1', sku:'GTR-1', title:'Strat', quantity:2,
    lineItemCost:{ value:'1200.00', currency:'USD' } }],
  pricingSummary:{ priceSubtotal:{value:'2400.00',currency:'USD'}, total:{value:'2475.00',currency:'USD'} },
} as any);
eq('ebay lineTotal exact', eo!.lineItems[0]!.lineTotal, '2400.00');
eq('ebay lineItemId kept', eo!.lineItems[0]!.externalListingId, 'LI-1');
eq('ebay name split', [eo!.buyerInfo!.firstName, eo!.buyerInfo!.lastName], ['Bob','Smith Jones']);

console.log('\n' + (fail === 0 ? 'ALL PASS' : `${fail} FAILURES`));
process.exit(fail === 0 ? 0 : 1);
