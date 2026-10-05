// Checks a Meta catalog CSV against Meta's required-field rules and prints a
// summary. Usage: node scripts/validate-feed.ts path/to/meta.csv

import { readFileSync } from 'node:fs';
import { AVAILABILITIES } from '../src/core/model.ts';

/** RFC 4180 parser: quoted fields may contain commas, quotes and newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const path = process.argv[2];
if (!path) throw new Error('usage: node scripts/validate-feed.ts <meta.csv>');
const [header, ...data] = parseCsv(readFileSync(path, 'utf8'));
if (!header) throw new Error('empty file');
const col = (name: string): number => header.indexOf(name);
const get = (r: string[], name: string): string => r[col(name)] ?? '';

if (col('vehicle_id') >= 0) {
  validateVehicles();
  process.exit(process.exitCode ?? 0);
}

/** Meta automotive inventory feed: required fields and enums (Auto Ads reference, Oct 2026). */
function validateVehicles(): void {
  if (!header) return;
  const required = ['vehicle_id', 'title', 'description', 'url', 'make', 'model', 'year', 'mileage.value', 'mileage.unit', 'image[0].url', 'body_style', 'price', 'exterior_color', 'state_of_vehicle', 'address.addr1', 'address.city', 'address.region', 'address.country', 'latitude', 'longitude'];
  const enums: Record<string, string[]> = {
    body_style: ['CONVERTIBLE', 'COUPE', 'CROSSOVER', 'HATCHBACK', 'MINIVAN', 'TRUCK', 'SUV', 'SEDAN', 'VAN', 'WAGON', 'SMALL_CAR', 'OTHER'],
    state_of_vehicle: ['New', 'Used', 'CPO'],
    availability: ['available', 'not_available'],
    'mileage.unit': ['MI', 'KM'],
  };
  const problems = new Map<string, number>();
  const note = (p: string): void => {
    problems.set(p, (problems.get(p) ?? 0) + 1);
  };
  const ids = new Set<string>();
  const count = (name: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of data) m.set(get(r, name), (m.get(get(r, name)) ?? 0) + 1);
    return m;
  };
  const prices: number[] = [];
  for (const r of data) {
    if (r.length !== header.length) note(`row has ${r.length} columns, expected ${header.length}`);
    for (const f of required) if (!get(r, f)) note(`missing ${f}`);
    for (const [f, allowed] of Object.entries(enums)) if (get(r, f) && !allowed.includes(get(r, f))) note(`invalid ${f} "${get(r, f)}"`);
    if (ids.has(get(r, 'vehicle_id'))) note('duplicate vehicle_id');
    ids.add(get(r, 'vehicle_id'));
    if (get(r, 'vin') && !/^[A-HJ-NPR-Z0-9]{17}$/.test(get(r, 'vin'))) note('vin not 17 characters');
    if (!/^\d{4}$/.test(get(r, 'year'))) note('year not yyyy');
    if (get(r, 'state_of_vehicle') === 'New' && get(r, 'mileage.value') !== '0') note('new vehicle with mileage');
    const m = /^(\d+\.\d{2}) [A-Z]{3}$/.exec(get(r, 'price'));
    if (!m?.[1]) note('price not "0.00 USD" format');
    else prices.push(Number(m[1]));
    for (const f of ['url', 'image[0].url']) if (get(r, f) && !get(r, f).startsWith('https://')) note(`${f} not https`);
  }
  const top = (m: Map<string, number>, n: number): string =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k || '(blank)'} ${v}`).join(', ');
  prices.sort((a, b) => a - b);
  console.log(`vehicles:       ${data.length}`);
  console.log(`state:          ${top(count('state_of_vehicle'), 3)}`);
  console.log(`availability:   ${top(count('availability'), 2)}`);
  console.log(`body styles:    ${top(count('body_style'), 6)}`);
  console.log(`makes:          ${top(count('make'), 6)}`);
  console.log(`price range:    $${prices[0]?.toFixed(0)} - $${prices[prices.length - 1]?.toFixed(0)}, median $${prices[Math.floor(prices.length / 2)]?.toFixed(0)}`);
  console.log(`dealer:         ${get(data[0] ?? [], 'dealer_name')}, ${get(data[0] ?? [], 'address.city')} ${get(data[0] ?? [], 'address.region')}`);
  console.log(problems.size ? `PROBLEMS:\n${[...problems].map(([p, n]) => `  ${p}: ${n}`).join('\n')}` : 'problems:       none (all required Meta vehicle fields present and valid)');
  process.exitCode = problems.size ? 1 : 0;
}

const REQUIRED = ['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link'];
const problems = new Map<string, number>();
const note = (p: string): void => {
  problems.set(p, (problems.get(p) ?? 0) + 1);
};
const ids = new Set<string>();
const groups = new Set<string>();
const availability = new Map<string, number>();
const brands = new Map<string, number>();
const types = new Map<string, number>();
const prices: number[] = [];
let withGtin = 0;
let withSize = 0;

for (const r of data) {
  if (r.length !== header.length) note(`row has ${r.length} columns, expected ${header.length}`);
  for (const f of REQUIRED) if (!get(r, f)) note(`missing ${f}`);
  if (!get(r, 'brand') && !get(r, 'gtin') && !get(r, 'mpn')) note('missing brand, gtin and mpn');
  const id = get(r, 'id');
  if (ids.has(id)) note('duplicate id');
  ids.add(id);
  groups.add(get(r, 'item_group_id'));
  const a = get(r, 'availability');
  if (!(AVAILABILITIES as readonly string[]).includes(a)) note(`invalid availability "${a}"`);
  availability.set(a, (availability.get(a) ?? 0) + 1);
  const m = /^(\d+\.\d{2}) ([A-Z]{3})$/.exec(get(r, 'price'));
  if (!m?.[1]) note('price not "0.00 USD" format');
  else prices.push(Number(m[1]));
  for (const f of ['link', 'image_link']) if (get(r, f) && !get(r, f).startsWith('https://')) note(`${f} not https`);
  if (get(r, 'title').length > 200) note('title over 200 chars');
  if (get(r, 'description').length > 9999) note('description over 9999 chars');
  const b = get(r, 'brand') || '(none)';
  brands.set(b, (brands.get(b) ?? 0) + 1);
  const t = get(r, 'product_type') || '(none)';
  types.set(t, (types.get(t) ?? 0) + 1);
  if (get(r, 'gtin')) withGtin++;
  if (get(r, 'size')) withSize++;
}

const top = (m: Map<string, number>, n: number): string =>
  [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
prices.sort((a, b) => a - b);
console.log(`items:          ${data.length} (${groups.size} products)`);
console.log(`availability:   ${top(availability, 5)}`);
console.log(`price range:    $${prices[0]?.toFixed(2)} - $${prices[prices.length - 1]?.toFixed(2)}, median $${prices[Math.floor(prices.length / 2)]?.toFixed(2)}`);
console.log(`with size:      ${withSize}   with GTIN: ${withGtin}`);
console.log(`brands:         ${top(brands, 8)}`);
console.log(`top categories: ${top(types, 8)}`);
console.log(problems.size ? `PROBLEMS:\n${[...problems].map(([p, n]) => `  ${p}: ${n}`).join('\n')}` : 'problems:       none (all required Meta fields present and well-formed)');
process.exitCode = problems.size ? 1 : 0;
