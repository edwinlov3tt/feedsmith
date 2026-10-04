// Warning-only route audit (never fails CI):
//  - routes registered outside app.openapi() (undocumented)
//  - documented operations whose handler file has STUB/TODO(stub) markers
//  - OpenAPI operations that the running router doesn't answer
// Usage: node scripts/audit-routes.ts

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from '../src/api/app.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'src/api/app.ts'), 'utf8');
const warnings: string[] = [];

// Plain app.get/post/... registrations bypass the OpenAPI contract. /docs is the documented exception.
for (const m of source.matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
  if (m[2] !== '/docs') warnings.push(`undocumented route: ${m[1]?.toUpperCase()} ${m[2]}`);
}
for (const m of source.matchAll(/\/\/\s*(STUB|TODO\(stub\))[^\n]*/g)) warnings.push(`stub marker in handlers: ${m[0].trim()}`);

// No real bindings: auth rejects admin routes first, and the feed route sees an empty DB.
const emptyDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };
const env = { ADMIN_TOKEN: '', TOKEN_ENC_KEY: '', USER_AGENT: 'audit', META_GRAPH_VERSION: 'v23.0', DB: emptyDb };
const docRes = await app.request('/openapi.json', {}, env);
const doc: unknown = await docRes.json();
const paths = typeof doc === 'object' && doc !== null && 'paths' in doc && typeof doc.paths === 'object' && doc.paths !== null ? doc.paths : {};

for (const [path, ops] of Object.entries(paths)) {
  if (typeof ops !== 'object' || ops === null) continue;
  for (const method of Object.keys(ops)) {
    const concrete = path.replace(/\{[^}]+\}/g, (p) => (p === '{runId}' ? '00000000-0000-4000-8000-000000000000' : 'audit-site'));
    // Any status but the router's own 404 shows the operation is wired.
    const res = await app.request(concrete, { method: method.toUpperCase() }, env);
    const body = await res.text();
    if (res.status === 404 && body.includes('"not found"')) warnings.push(`documented but not wired: ${method.toUpperCase()} ${path}`);
  }
}

if (warnings.length) {
  for (const w of warnings) console.warn(`::warning::${w}`);
  console.warn(`route audit: ${warnings.length} warning(s)`);
} else {
  console.log(`route audit: ${Object.keys(paths).length} documented paths, all wired, no undocumented routes`);
}
