import { z } from 'zod';
import { AGE_GROUPS, GENDERS } from './normalize.ts';

// Platform-neutral product model. Every adapter produces these; everything
// downstream (diffing, feeds, the Meta push) only ever sees these.

export const AVAILABILITIES = [
  'in stock',
  'out of stock',
  'preorder',
  'available for order',
  'discontinued',
] as const;
export type Availability = (typeof AVAILABILITIES)[number];

export const PLATFORMS = ['prismrbs', 'jsonld', 'dealeron'] as const;
export type PlatformId = (typeof PLATFORMS)[number];

/** Meta catalog verticals Feedsmith can publish. */
export const CATALOG_TYPES = ['commerce', 'vehicles'] as const;
export type CatalogType = (typeof CATALOG_TYPES)[number];

export const MoneySchema = z.object({
  /** Decimal string with two places, e.g. "30.00". */
  amount: z.string().regex(/^\d{1,9}\.\d{2}$/),
  /** ISO 4217 code. */
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export type Money = z.infer<typeof MoneySchema>;

const shortText = z.string().max(500);
const webUrl = z.url({ protocol: /^https?$/ }).max(2000);

// Meta automotive inventory feed enums (Auto Ads reference, Vehicle, Oct 2026).
export const BODY_STYLES = ['CONVERTIBLE', 'COUPE', 'CROSSOVER', 'HATCHBACK', 'MINIVAN', 'TRUCK', 'SUV', 'SEDAN', 'VAN', 'WAGON', 'SMALL_CAR', 'OTHER'] as const;
export const VEHICLE_STATES = ['New', 'Used', 'CPO'] as const;
export const DRIVETRAINS = ['4X2', '4X4', 'AWD', 'FWD', 'RWD', 'Other'] as const;
export const FUEL_TYPES = ['DIESEL', 'ELECTRIC', 'FLEX', 'GASOLINE', 'HYBRID', 'OTHER'] as const;

/** The dealership a vehicle is sold from. Meta requires its address and coordinates. */
export const DealerSchema = z.object({
  name: z.string().min(1).max(100),
  phone: z.string().max(40).nullable(),
  addr1: z.string().min(1).max(200),
  city: z.string().min(1).max(100),
  region: z.string().min(1).max(100),
  postalCode: z.string().max(20).nullable(),
  country: z.string().min(2).max(100),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type Dealer = z.infer<typeof DealerSchema>;

/** Vehicle-specific fields. Present only on items of a vehicles catalog. */
export const VehicleFieldsSchema = z.object({
  vin: z.string().regex(/^[A-HJ-NPR-Z0-9]{17}$/).nullable(),
  make: z.string().min(1).max(100),
  model: z.string().min(1).max(100),
  year: z.number().int().min(1900).max(2100),
  trim: z.string().max(50).nullable(),
  /** Miles or kilometers; 0 for new vehicles, as Meta requires. */
  mileage: z.number().int().min(0),
  mileageUnit: z.enum(['MI', 'KM']),
  bodyStyle: z.enum(BODY_STYLES),
  state: z.enum(VEHICLE_STATES),
  drivetrain: z.enum(DRIVETRAINS).nullable(),
  fuelType: z.enum(FUEL_TYPES).nullable(),
  transmission: z.enum(['Automatic', 'Manual']).nullable(),
  interiorColor: z.string().max(50).nullable(),
  stockNumber: z.string().max(50).nullable(),
  dealer: DealerSchema,
});
export type VehicleFields = z.infer<typeof VehicleFieldsSchema>;

/**
 * One purchasable item: a single size/color combination. Meta calls this an
 * item. Defined as a schema because variants round-trip through D1, and rows
 * read back are parsed rather than trusted.
 */
export const VariantSchema = z.object({
  /** Retailer ID: the SKU. Becomes Meta `id` and must match pixel `content_ids`. */
  id: z.string().min(1).max(100),
  /** Product the variant belongs to. Becomes Meta `item_group_id`. */
  groupId: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(9999),
  link: webUrl,
  imageLink: webUrl.nullable(),
  // Up to 19 extra (Meta takes 20 images per vehicle; the product feed uses the first 10).
  additionalImageLinks: z.array(webUrl).max(19),
  brand: shortText.nullable(),
  price: MoneySchema,
  salePrice: MoneySchema.nullable(),
  availability: z.enum(AVAILABILITIES),
  /** Named options as the site labels them, e.g. { Color: "IVORY", Size: "SM UNISEX" }. */
  attributes: z.record(z.string().max(100), shortText),
  size: shortText.nullable(),
  color: shortText.nullable(),
  // Defaults keep rows stored before these fields existed parseable.
  gender: z.enum(GENDERS).nullable().default(null),
  ageGroup: z.enum(AGE_GROUPS).nullable().default(null),
  gtin: z.string().regex(/^\d{8,14}$/).nullable(),
  mpn: shortText.nullable(),
  productType: shortText.nullable(),
  /** "Only 2 left" style hint when the site shows one; never exact inventory. */
  lowStockHint: z.number().int().min(0).nullable(),
  // Merchandising labels for product sets. Defaults keep older rows parseable.
  /** The store's own top-level department, e.g. "Bama Merchandise". */
  department: shortText.nullable().default(null),
  /** Listed in a clearance or sale category. */
  clearance: z.boolean().default(false),
  /** Listed in a featured category. */
  featured: z.boolean().default(false),
  /** Set on vehicles-catalog items; null for products. */
  vehicle: VehicleFieldsSchema.nullable().default(null),
});
export type Variant = z.infer<typeof VariantSchema>;

/** How a product is found again later; stored so sweeps can skip discovery. */
export const ProductRefSchema = z.object({
  /** Stable per-site key, e.g. PrismRBS pf_id or a canonical URL path. */
  key: z.string().min(1).max(500),
  url: webUrl,
  /** Most specific non-promotional category; becomes product_type. */
  category: shortText.nullable(),
  department: shortText.nullable().default(null),
  clearance: z.boolean().default(false),
  featured: z.boolean().default(false),
});
export type ProductRef = z.infer<typeof ProductRefSchema>;

export type ReadResult =
  | { kind: 'ok'; variants: Variant[] }
  /** The site says the product no longer exists: every variant is out of stock. */
  | { kind: 'gone'; reason: string }
  /** The page is valid but is not a product (generic crawling hits these). */
  | { kind: 'not_product' }
  | { kind: 'error'; message: string };

export interface DiscoverResult {
  refs: ProductRef[];
  pagesFetched: number;
  warnings: string[];
  /**
   * True when discovery may have missed products (a cap was hit or a listing
   * page failed). Undiscovered products are then not counted as vanished.
   */
  truncated: boolean;
  /** Vehicles: the dealership found during discovery, saved on the site for reads. */
  dealer?: Dealer | undefined;
}
