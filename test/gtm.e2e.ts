// Live check of gtm/prismrbs-meta-events.html on the real store: injects the
// tag into a product page with a recording fbq stub, picks a size, adds to a
// throwaway cart (temporary browser context, never checks out), and asserts
// the events Meta would receive.
//
// Run: node test/gtm.e2e.ts

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';

const SITE = 'https://www.universitysupplystore.com';
const PRODUCT = `${SITE}/shop_product_detail.asp?pf_id=211098&type=1`;
const here = dirname(fileURLToPath(import.meta.url));
const tag = readFileSync(join(here, '..', 'gtm', 'prismrbs-meta-events.html'), 'utf8');
function extractScript(html: string): string {
  const body = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
  if (!body) throw new Error('no <script> block in the GTM tag');
  return body;
}
const script = extractScript(tag);

let browser: Browser | null = null;
const watchdog = setTimeout(() => {
  console.error('FAIL: 300 s deadline hit');
  void (browser?.close() ?? Promise.resolve()).finally(() => process.exit(2));
}, 300_000);

function check(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`ok - ${msg}`);
}

interface FbqCall {
  args: unknown[];
}

async function main(): Promise<void> {
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    // Defined before any site script: the real pixel snippet keeps an existing fbq.
    await page.addInitScript(() => {
      const calls: Array<{ args: unknown[] }> = [];
      Object.defineProperty(globalThis, '__fbqCalls', { value: calls });
      const stub = (...args: unknown[]): void => {
        calls.push({ args });
      };
      Object.defineProperty(globalThis, 'fbq', { value: stub, writable: true, configurable: true });
    });
    await page.goto(PRODUCT, { waitUntil: 'load' });
    await page.addScriptTag({ content: script });

    const calls = async (): Promise<FbqCall[]> => page.evaluate(() => Reflect.get(globalThis, '__fbqCalls'));
    const tracked = async (name: string): Promise<FbqCall[]> => (await calls()).filter((c) => c.args[0] === 'track' && c.args[1] === name);

    const views = await tracked('ViewContent');
    check(views.length === 1, 'ViewContent fired once on the product page');
    check(JSON.stringify(views[0]?.args[2]).includes('"content_ids":["211098"]'), 'ViewContent content_ids = pf_id (feed item_group_id)');
    check(JSON.stringify(views[0]?.args[2]).includes('"content_type":"product_group"'), 'ViewContent content_type = product_group');

    await page.locator('#ajaxAddToCart').click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(1500);
    check((await tracked('AddToCart')).length === 0, 'no AddToCart before a size is chosen');

    const size = page.locator('#product-options-list .product-option').nth(1).locator('button.available').first();
    await size.click();
    const sku = await page.locator('#pf_sku').inputValue();
    check(/^\d{8,}$/.test(sku), `size selected, SKU ${sku}`);
    await page.locator('#ajaxAddToCart').click();
    await page.waitForFunction(
      () => {
        const recorded: unknown = Reflect.get(globalThis, '__fbqCalls');
        return Array.isArray(recorded) && recorded.some((c: unknown) => typeof c === 'object' && c !== null && 'args' in c && Array.isArray(c.args) && c.args[1] === 'AddToCart');
      },
      null,
      { timeout: 20_000 },
    );
    const adds = await tracked('AddToCart');
    check(adds.length === 1, 'AddToCart fired once after the store confirmed the add');
    const params = JSON.stringify(adds[0]?.args[2]);
    check(params.includes(`"content_ids":["${sku}"]`), 'AddToCart content_ids = selected SKU (feed id)');
    check(params.includes('"currency":"USD"') && /"value":\d/.test(params), 'AddToCart carries value and currency');
    console.log('AddToCart params:', params);
  } finally {
    await context.close();
  }
}

main()
  .then(() => console.log('PASS'))
  .catch((err: unknown) => {
    console.error('FAIL:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    clearTimeout(watchdog);
    await browser?.close();
  });
