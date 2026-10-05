import { describe, expect, it } from 'vitest';
import { dealeron, mapBodyStyle, mapDrivetrain, mapFuel, parseDealer, parseInventoryPage, parseVehiclePage, vinAttributes } from '../src/adapters/dealeron.ts';
import { csvHeader, csvLine, feedProblem, toVehicleRow } from '../src/core/feed.ts';
import { VariantSchema, type ProductRef, type Variant } from '../src/core/model.ts';
import { matchesSet, parseSetFilter } from '../src/core/set-filter.ts';
import { batchItemType, batchRequests } from '../src/pipeline/meta.ts';
import { fixture, testSite } from './helpers.ts';

const BASE = 'https://www.northstarfordduluth.com/';
const dealer = parseDealer(fixture('dealeron-home.html'));
const site = testSite({ id: 'northstar-ford', name: 'NorthStar Ford', baseUrl: BASE, platform: 'dealeron' }, { dealer, defaultBrand: null, brandKeywords: [] });
const ref = (vin: string, condition: 'New' | 'Used', url: string): ProductRef => ({ key: vin, url, category: condition, department: null, clearance: false, featured: false });

function read(file: string, vin: string, condition: 'New' | 'Used'): Variant {
  const url = `${BASE}${condition === 'New' ? 'new' : 'used'}-Duluth-x-${vin}`;
  const r = parseVehiclePage(fixture(file), ref(vin, condition, url), site, url);
  if (r.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  const v = r.variants[0];
  if (!v) throw new Error('no variant');
  return v;
}

describe('dealeron discovery', () => {
  it('reads the dealership from the homepage', () => {
    expect(dealer).toEqual({
      name: 'NorthStar Ford MN',
      phone: '+12183282111',
      addr1: '1420 Miller Trunk Hwy',
      city: 'Duluth',
      region: 'MN',
      postalCode: '55811',
      country: 'US',
      latitude: 46.80489,
      longitude: -92.155769,
    });
  });

  it('bounds every dealer field a hostile or odd page supplies', () => {
    const ld = { '@type': 'AutoDealer', name: 'D'.repeat(500), telephone: '1'.repeat(300), address: { streetAddress: 'S'.repeat(5000), addressLocality: 'C'.repeat(500), addressRegion: 'R'.repeat(500), postalCode: 'P'.repeat(300), addressCountry: 'X'.repeat(500) }, geo: { latitude: 46.8, longitude: -92.1 } };
    const d = parseDealer(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`);
    expect(d).not.toBeNull();
    expect([d?.name.length, d?.phone?.length, d?.addr1.length, d?.city.length, d?.postalCode?.length, d?.country.length]).toEqual([100, 40, 200, 100, 20, 100]);
    // Out-of-range coordinates are not a dealer.
    const bad = { ...ld, geo: { latitude: 999, longitude: 0 } };
    expect(parseDealer(`<script type="application/ld+json">${JSON.stringify(bad)}</script>`)).toBeNull();
  });

  it('reads vehicle URLs and VINs from an inventory page', () => {
    const refs = parseInventoryPage(fixture('dealeron-srp-used.html'), BASE, 'Used');
    expect(refs).toHaveLength(24);
    expect(refs[0]).toEqual({
      key: '1FM5K8D88FGC65422',
      url: 'https://www.northstarfordduluth.com/used-Duluth-2015-Ford-Explorer-XLT-1FM5K8D88FGC65422',
      category: 'Used',
      department: null,
      clearance: false,
      featured: false,
    });
    expect(new Set(refs.map((r) => r.key)).size).toBe(24);
  });

  it('detects the platform', () => {
    expect(dealeron.detect(fixture('dealeron-home.html'))).toBe(true);
    expect(dealeron.detect(fixture('prism-home.html'))).toBe(false);
  });

  it('turns a vehicle page URL into a ref keyed by VIN', () => {
    expect(dealeron.refFromUrl('https://www.northstarfordduluth.com/new-Duluth-2026-Ford-Bronco+Sport-Big+Bend-3FMCR9BN6TRF07128', site)).toMatchObject({ key: '3FMCR9BN6TRF07128', category: 'New' });
    expect(dealeron.refFromUrl('https://www.northstarfordduluth.com/searchnew.aspx', site)).toBeNull();
  });
});

describe('dealeron vehicle pages', () => {
  it('reads a used vehicle with odometer, trim, colors and photos', () => {
    const v = read('dealeron-vdp-used.html', '1FM5K8D88FGC65422', 'Used');
    expect(VariantSchema.safeParse(v).success).toBe(true);
    expect(v).toMatchObject({ id: '1FM5K8D88FGC65422', title: '2015 Ford Explorer XLT', price: { amount: '5843.00', currency: 'USD' }, color: 'Magnetic Metallic', availability: 'in stock', productType: 'Used' });
    expect(v.vehicle).toMatchObject({
      vin: '1FM5K8D88FGC65422',
      make: 'Ford',
      model: 'Explorer',
      year: 2015,
      trim: 'XLT',
      mileage: 254122,
      mileageUnit: 'MI',
      bodyStyle: 'SUV',
      state: 'Used',
      fuelType: 'GASOLINE',
      interiorColor: 'Medium Light Stone',
      stockNumber: 'FGC65422',
    });
    expect(v.imageLink).toBe('https://www.northstarfordduluth.com/inventoryphotos/19054/1fm5k8d88fgc65422/ip/1.jpg');
    // 32 photos on the page; Meta takes 20.
    expect(v.additionalImageLinks).toHaveLength(19);
    expect(v.additionalImageLinks[0]).toMatch(/\/ip\/2\.jpg$/);
    expect(v.description).not.toMatch(/<br/);
  });

  it('reads a new vehicle with zero mileage, ignoring the similar-vehicle card', () => {
    const v = read('dealeron-vdp-new.html', '3FMCR9BN6TRF07128', 'New');
    expect(v.vehicle).toMatchObject({ make: 'Ford', model: 'Bronco Sport', year: 2026, trim: 'Big Bend', mileage: 0, state: 'New' });
    expect(v.color).toBe('Space White Metallic');
    // The structured offer price, not the data-price or MSRP attributes.
    expect(v.price.amount).toBe('33118.00');
  });

  it('only reads data attributes on this vehicle\'s VIN', () => {
    const attrs = vinAttributes(fixture('dealeron-vdp-used.html'), '1FM5K8D88FGC65422');
    expect(attrs['odometer']).toBe('254122');
    expect(attrs['vin']).toBe('1FM5K8D88FGC65422');
  });

  it('refuses to read without a known dealership (Meta requires the address)', () => {
    const noDealer = testSite({ platform: 'dealeron', baseUrl: BASE });
    const url = `${BASE}used-x`;
    expect(parseVehiclePage(fixture('dealeron-vdp-used.html'), ref('1FM5K8D88FGC65422', 'Used', url), noDealer, url).kind).toBe('error');
  });

  it('maps body styles, fuel and drivetrain to Meta enums', () => {
    expect(mapBodyStyle('4D Sport Utility')).toBe('SUV');
    expect(mapBodyStyle('Crew Cab Pickup')).toBe('TRUCK');
    expect(mapBodyStyle('SuperCrew')).toBe('TRUCK');
    expect(mapBodyStyle('4D Sedan')).toBe('SEDAN');
    expect(mapBodyStyle('Passenger Van')).toBe('MINIVAN');
    expect(mapBodyStyle('Cargo Van')).toBe('VAN');
    expect(mapBodyStyle(null)).toBe('OTHER');
    expect(mapFuel('Flex Fuel')).toBe('FLEX');
    expect(mapFuel('Gasoline')).toBe('GASOLINE');
    expect(mapFuel('Plug-In Hybrid')).toBe('HYBRID');
    expect(mapDrivetrain('4WD')).toBe('4X4');
    expect(mapDrivetrain('')).toBeNull();
  });
});

describe('vehicle feed and Batch API', () => {
  const used = read('dealeron-vdp-used.html', '1FM5K8D88FGC65422', 'Used');

  it('writes Meta\'s automotive columns', () => {
    const row = toVehicleRow(used);
    expect(row).toMatchObject({
      vehicle_id: '1FM5K8D88FGC65422',
      make: 'Ford',
      model: 'Explorer',
      year: '2015',
      'mileage.value': '254122',
      'mileage.unit': 'MI',
      body_style: 'SUV',
      price: '5843.00 USD',
      exterior_color: 'Magnetic Metallic',
      state_of_vehicle: 'Used',
      'address.addr1': '1420 Miller Trunk Hwy',
      'address.city': 'Duluth',
      'address.region': 'MN',
      'address.country': 'US',
      latitude: '46.80489',
      longitude: '-92.155769',
      availability: 'available',
      custom_label_0: 'Under $20k',
    });
    expect(row['image[0].url']).toMatch(/ip\/1\.jpg$/);
    expect(row['image[9].url']).toMatch(/ip\/10\.jpg$/);
    const header = csvHeader('vehicles');
    expect(header.startsWith('vehicle_id,title,description,url,make,model,year,mileage.value,mileage.unit,image[0].url')).toBe(true);
    expect(csvLine(row, 'vehicles').split(',')[0]).toBe('1FM5K8D88FGC65422');
  });

  it('marks a sold vehicle not_available and leaves out ones without a price', () => {
    expect(toVehicleRow({ ...used, availability: 'out of stock' })['availability']).toBe('not_available');
    expect(feedProblem({ ...used, price: { amount: '0.00', currency: 'USD' } })).toBe('missing price');
    expect(feedProblem(used)).toBeNull();
  });

  it('sends VEHICLE items with nested mileage and address', () => {
    expect(batchItemType([used])).toBe('VEHICLE');
    const [req] = batchRequests([used]);
    expect(req?.data).toMatchObject({
      vehicle_id: '1FM5K8D88FGC65422',
      year: 2015,
      mileage: { value: 254122, unit: 'MI' },
      address: { addr1: '1420 Miller Trunk Hwy', city: 'Duluth', region: 'MN', country: 'US', postal_code: '55811' },
      latitude: 46.80489,
      state_of_vehicle: 'Used',
      body_style: 'SUV',
      vin: '1FM5K8D88FGC65422',
    });
    expect((req?.data['image'] as unknown[]).length).toBe(20);
  });

  it('filters vehicle sets on vehicle fields, with year as a number', () => {
    const row = toVehicleRow(used);
    const parse = (raw: unknown) => {
      const r = parseSetFilter(raw, 'vehicles');
      if (!r.ok) throw new Error(r.error);
      return r.filter;
    };
    expect(matchesSet(parse({ and: [{ availability: { eq: 'available' } }, { state_of_vehicle: { is_any: ['Used', 'CPO'] } }] }), row)).toBe(true);
    expect(matchesSet(parse({ year: { gte: 2020 } }), row)).toBe(false);
    expect(matchesSet(parse({ body_style: { eq: 'suv' } }), row)).toBe(true);
    expect(parseSetFilter({ gender: { eq: 'female' } }, 'vehicles').ok).toBe(false);
    expect(parseSetFilter({ year: { gte: '2020' } }, 'vehicles').ok).toBe(false);
  });
});
