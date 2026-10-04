import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { adapterFor, detectPlatform } from '../adapters/registry.ts';
import { decryptSecret, encryptSecret, randomToken, safeEqual, sha256Hex } from '../core/crypto.ts';
import { HttpClient, parsePublicHttpsUrl, siteHosts } from '../core/http.ts';
import { AVAILABILITIES, PLATFORMS, VariantSchema } from '../core/model.ts';
import { SiteConfigPatchSchema, SiteConfigSchema, SiteIdSchema, validatePatterns, type Site } from '../core/site.ts';
import { CatalogIdSchema, checkBatchStatus, verifyCatalogAccess } from '../pipeline/meta.ts';
import { feedKey } from '../pipeline/publish.ts';
import { httpFor, startRun } from '../pipeline/run.ts';
import {
  getFeedPasswordHash,
  getMetaTokenEnc,
  getRun,
  getSite,
  insertSite,
  listChanges,
  listRuns,
  listSites,
  sampleErrors,
  setFeedPasswordHash,
  setMetaCredentials,
  updateSiteBasics,
  variantStats,
  type Run,
  type SiteRecord,
} from '../pipeline/store.ts';
import { basicCredentials, requireAdmin } from './auth.ts';

type AppEnv = { Bindings: Env };

export const app = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json({ error: 'invalid request', issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }, 400);
    }
    return undefined;
  },
});

app.use('*', secureHeaders());
app.use('/admin/*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'request body too large' }, 413) }));
app.use('/admin/*', requireAdmin);

// ---------- shared schemas ----------

const ErrorSchema = z.object({ error: z.string() }).openapi('Error');
const ValidationErrorSchema = z
  .object({ error: z.string(), issues: z.array(z.object({ path: z.string(), message: z.string() })) })
  .openapi('ValidationError');

const SiteSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    baseUrl: z.string(),
    platform: z.enum(PLATFORMS),
    config: z.record(z.string(), z.unknown()),
    metaCatalogId: z.string().nullable(),
    metaConnected: z.boolean(),
    lastDiscoveryCount: z.number().nullable(),
    feedUrl: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Site');

const RunSchema = z
  .object({
    id: z.string(),
    siteId: z.string(),
    mode: z.enum(['full', 'sweep']),
    status: z.enum(['discovering', 'crawling', 'finalizing', 'published', 'rejected', 'failed']),
    total: z.number(),
    discovered: z.number().nullable(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    error: z.string().nullable(),
    notes: z.record(z.string(), z.unknown()),
  })
  .openapi('Run');

const SiteIdParam = z.object({ siteId: SiteIdSchema.openapi({ param: { name: 'siteId', in: 'path' }, example: 'supe-store' }) });
const RunIdParam = z.object({ runId: z.uuid().openapi({ param: { name: 'runId', in: 'path' } }) });

// Request bodies use the patch schema: no defaults, so only keys the caller sent are applied.
const ConfigInput = SiteConfigPatchSchema;

function feedUrlFor(origin: string, siteId: string): string {
  return `${origin}/feeds/${siteId}/meta.csv`;
}

function siteDto(site: SiteRecord, origin: string): z.infer<typeof SiteSchema> {
  return {
    id: site.id,
    name: site.name,
    baseUrl: site.baseUrl,
    platform: site.platform,
    config: site.config,
    metaCatalogId: site.metaCatalogId,
    metaConnected: site.hasMetaToken,
    lastDiscoveryCount: site.lastDiscoveryCount,
    feedUrl: feedUrlFor(origin, site.id),
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
  };
}

function runDto(run: Run): z.infer<typeof RunSchema> {
  return { ...run };
}

const admin = [{ AdminToken: [] }];
const unauthorized = { 401: { description: 'Missing or wrong admin token', content: { 'application/json': { schema: ErrorSchema } } } };
const notFound = { 404: { description: 'Not found', content: { 'application/json': { schema: ErrorSchema } } } };
const invalid = { 400: { description: 'Invalid request', content: { 'application/json': { schema: ValidationErrorSchema } } } };

/** Normalizes a store URL to origin + path with a trailing slash. */
function normalizeBaseUrl(raw: string): string | null {
  const url = parsePublicHttpsUrl(raw);
  if (!url) return null;
  const path = url.pathname.replace(/[^/]*\.(asp|aspx|php|html?)$/i, '');
  return `${url.origin}${path.endsWith('/') ? path : `${path}/`}`;
}

function patternError(config: z.infer<typeof ConfigInput>): string | null {
  return validatePatterns([...(config.includeUrlPatterns ?? []), ...(config.excludeUrlPatterns ?? [])]);
}

// ---------- health ----------

app.openapi(
  createRoute({
    method: 'get',
    path: '/health',
    tags: ['System'],
    summary: 'Liveness check',
    responses: { 200: { description: 'OK', content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } } } },
  }),
  (c) => c.json({ ok: true as const }, 200),
);

// ---------- sites ----------

app.openapi(
  createRoute({
    method: 'post',
    path: '/admin/sites',
    tags: ['Sites'],
    summary: 'Add a site',
    description:
      'Registers a storefront. When `platform` is omitted the homepage is fetched and the platform detected. The feed password is returned once; store it in Meta Commerce Manager.',
    security: admin,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              id: SiteIdSchema,
              name: z.string().trim().min(1).max(200),
              baseUrl: z.string().max(500),
              platform: z.enum(PLATFORMS).optional(),
              config: ConfigInput.optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: { description: 'Created', content: { 'application/json': { schema: z.object({ site: SiteSchema, feedPassword: z.string() }) } } },
      ...invalid,
      ...unauthorized,
      409: { description: 'Site ID taken', content: { 'application/json': { schema: ErrorSchema } } },
      422: { description: 'URL unusable or platform not detected', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    if (!baseUrl) return c.json({ error: 'baseUrl must be a public https URL' }, 422);
    const config = SiteConfigSchema.parse(body.config ?? {});
    const bad = patternError(config);
    if (bad) return c.json({ error: bad }, 422);
    if (await getSite(c.env.DB, body.id)) return c.json({ error: 'site ID already exists' }, 409);

    let platform = body.platform ?? null;
    if (!platform) {
      const http = new HttpClient({ allowedHosts: siteHosts(baseUrl), userAgent: c.env.USER_AGENT });
      const home = await http.getText(baseUrl);
      if (!home.ok) return c.json({ error: `could not fetch the site: ${home.error}` }, 422);
      platform = detectPlatform(home.text);
      if (!platform) return c.json({ error: 'no supported platform detected; pass platform explicitly or add an adapter' }, 422);
    }
    const site: Site = { id: body.id, name: body.name, baseUrl, platform, config, metaCatalogId: null, lastDiscoveryCount: null };
    const feedPassword = randomToken();
    await insertSite(c.env.DB, site, await sha256Hex(feedPassword));
    const saved = await getSite(c.env.DB, site.id);
    if (!saved) throw new Error('site vanished after insert');
    return c.json({ site: siteDto(saved, new URL(c.req.url).origin), feedPassword }, 201);
  },
);

app.openapi(
  createRoute({
    method: 'get',
    path: '/admin/sites',
    tags: ['Sites'],
    summary: 'List sites',
    security: admin,
    responses: { 200: { description: 'Sites', content: { 'application/json': { schema: z.object({ sites: z.array(SiteSchema) }) } } }, ...unauthorized },
  }),
  async (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json({ sites: (await listSites(c.env.DB)).map((s) => siteDto(s, origin)) }, 200);
  },
);

app.openapi(
  createRoute({
    method: 'get',
    path: '/admin/sites/{siteId}',
    tags: ['Sites'],
    summary: 'Get a site with variant counts by availability',
    security: admin,
    request: { params: SiteIdParam },
    responses: {
      200: { description: 'Site', content: { 'application/json': { schema: z.object({ site: SiteSchema, variants: z.record(z.string(), z.number()) }) } } },
      ...unauthorized,
      ...notFound,
    },
  }),
  async (c) => {
    const { siteId } = c.req.valid('param');
    const site = await getSite(c.env.DB, siteId);
    if (!site) return c.json({ error: 'site not found' }, 404);
    return c.json({ site: siteDto(site, new URL(c.req.url).origin), variants: await variantStats(c.env.DB, siteId) }, 200);
  },
);

app.openapi(
  createRoute({
    method: 'patch',
    path: '/admin/sites/{siteId}',
    tags: ['Sites'],
    summary: 'Update name or crawl config',
    description: 'Only `name` and `config` fields can change here. Base URL and platform are fixed; Meta credentials and the feed password have their own endpoints.',
    security: admin,
    request: {
      params: SiteIdParam,
      body: { content: { 'application/json': { schema: z.object({ name: z.string().trim().min(1).max(200).optional(), config: ConfigInput.optional() }).strict() } } },
    },
    responses: { 200: { description: 'Updated', content: { 'application/json': { schema: z.object({ site: SiteSchema }) } } }, ...invalid, ...unauthorized, ...notFound, 422: { description: 'Invalid config', content: { 'application/json': { schema: ErrorSchema } } } },
  }),
  async (c) => {
    const { siteId } = c.req.valid('param');
    const body = c.req.valid('json');
    const site = await getSite(c.env.DB, siteId);
    if (!site) return c.json({ error: 'site not found' }, 404);
    const config = SiteConfigSchema.parse({ ...site.config, ...(body.config ?? {}) });
    const bad = patternError(config);
    if (bad) return c.json({ error: bad }, 422);
    await updateSiteBasics(c.env.DB, siteId, body.name ?? site.name, config);
    const saved = await getSite(c.env.DB, siteId);
    if (!saved) return c.json({ error: 'site not found' }, 404);
    return c.json({ site: siteDto(saved, new URL(c.req.url).origin) }, 200);
  },
);

app.openapi(
  createRoute({
    method: 'post',
    path: '/admin/sites/{siteId}/feed-password',
    tags: ['Sites'],
    summary: 'Rotate the feed password',
    description: 'The old password stops working immediately. Update the scheduled feed in Commerce Manager.',
    security: admin,
    request: { params: SiteIdParam },
    responses: { 200: { description: 'New password', content: { 'application/json': { schema: z.object({ feedPassword: z.string() }) } } }, ...unauthorized, ...notFound },
  }),
  async (c) => {
    const { siteId } = c.req.valid('param');
    if (!(await getSite(c.env.DB, siteId))) return c.json({ error: 'site not found' }, 404);
    const feedPassword = randomToken();
    await setFeedPasswordHash(c.env.DB, siteId, await sha256Hex(feedPassword));
    return c.json({ feedPassword }, 200);
  },
);

app.openapi(
  createRoute({
    method: 'put',
    path: '/admin/sites/{siteId}/meta',
    tags: ['Meta'],
    summary: 'Connect a Meta catalog',
    description:
      'Stores the catalog ID and a system-user access token (catalog_management). The token is checked against the catalog first, then stored encrypted and never returned.',
    security: admin,
    request: {
      params: SiteIdParam,
      body: { content: { 'application/json': { schema: z.object({ catalogId: CatalogIdSchema, accessToken: z.string().min(20).max(1000) }).strict() } } },
    },
    responses: {
      200: { description: 'Connected', content: { 'application/json': { schema: z.object({ catalogId: z.string(), catalogName: z.string() }) } } },
      ...invalid,
      ...unauthorized,
      ...notFound,
      422: { description: 'Token cannot access that catalog', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { siteId } = c.req.valid('param');
    const { catalogId, accessToken } = c.req.valid('json');
    if (!(await getSite(c.env.DB, siteId))) return c.json({ error: 'site not found' }, 404);
    const check = await verifyCatalogAccess({ catalogId, token: accessToken, graphVersion: c.env.META_GRAPH_VERSION });
    if (!check.ok) return c.json({ error: `Meta rejected the token for this catalog: ${check.error}` }, 422);
    await setMetaCredentials(c.env.DB, siteId, catalogId, await encryptSecret(accessToken, c.env.TOKEN_ENC_KEY));
    return c.json({ catalogId, catalogName: check.name }, 200);
  },
);

app.openapi(
  createRoute({
    method: 'delete',
    path: '/admin/sites/{siteId}/meta',
    tags: ['Meta'],
    summary: 'Disconnect the Meta catalog',
    security: admin,
    request: { params: SiteIdParam },
    responses: { 204: { description: 'Disconnected' }, ...unauthorized, ...notFound },
  }),
  async (c) => {
    const { siteId } = c.req.valid('param');
    if (!(await getSite(c.env.DB, siteId))) return c.json({ error: 'site not found' }, 404);
    await setMetaCredentials(c.env.DB, siteId, null, null);
    return c.body(null, 204);
  },
);

// ---------- runs ----------

app.openapi(
  createRoute({
    method: 'post',
    path: '/admin/sites/{siteId}/runs',
    tags: ['Runs'],
    summary: 'Start a crawl',
    description: '`full` discovers every product; `sweep` re-reads known products for stock and price. The first run of a site is always full. Returns immediately; poll the run.',
    security: admin,
    request: { params: SiteIdParam, body: { content: { 'application/json': { schema: z.object({ mode: z.enum(['full', 'sweep']).default('full') }) } } } },
    responses: {
      202: { description: 'Started', content: { 'application/json': { schema: z.object({ run: RunSchema }) } } },
      ...invalid,
      ...unauthorized,
      ...notFound,
      409: { description: 'A run is already in progress', content: { 'application/json': { schema: z.object({ error: z.string(), run: RunSchema.nullable() }) } } },
    },
  }),
  async (c) => {
    const { siteId } = c.req.valid('param');
    const { mode } = c.req.valid('json');
    const result = await startRun(c.env, siteId, mode);
    switch (result.kind) {
      case 'no_site':
        return c.json({ error: 'site not found' }, 404);
      case 'busy':
        return c.json({ error: 'a run is already in progress', run: result.run ? runDto(result.run) : null }, 409);
      case 'started':
        return c.json({ run: runDto(result.run) }, 202);
      default: {
        const unreachable: never = result;
        throw new Error(`unhandled start result ${JSON.stringify(unreachable)}`);
      }
    }
  },
);

app.openapi(
  createRoute({
    method: 'get',
    path: '/admin/sites/{siteId}/runs',
    tags: ['Runs'],
    summary: 'Recent runs',
    security: admin,
    request: { params: SiteIdParam, query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }) },
    responses: { 200: { description: 'Runs, newest first', content: { 'application/json': { schema: z.object({ runs: z.array(RunSchema) }) } } }, ...unauthorized },
  }),
  async (c) => {
    const { siteId } = c.req.valid('param');
    const { limit } = c.req.valid('query');
    return c.json({ runs: (await listRuns(c.env.DB, siteId, limit)).map(runDto) }, 200);
  },
);

app.openapi(
  createRoute({
    method: 'get',
    path: '/admin/runs/{runId}',
    tags: ['Runs'],
    summary: 'Run detail with an error sample',
    security: admin,
    request: { params: RunIdParam },
    responses: {
      200: { description: 'Run', content: { 'application/json': { schema: z.object({ run: RunSchema, errors: z.array(z.object({ key: z.string(), message: z.string().nullable() })) }) } } },
      ...unauthorized,
      ...notFound,
    },
  }),
  async (c) => {
    const { runId } = c.req.valid('param');
    const run = await getRun(c.env.DB, runId);
    if (!run) return c.json({ error: 'run not found' }, 404);
    return c.json({ run: runDto(run), errors: await sampleErrors(c.env.DB, runId, 50) }, 200);
  },
);

app.openapi(
  createRoute({
    method: 'get',
    path: '/admin/runs/{runId}/meta-status',
    tags: ['Meta'],
    summary: "How Meta processed a run's Batch API pushes",
    description: "Meta ingests batches asynchronously. This asks Meta's check_batch_request_status for each handle the run received, including per-item errors.",
    security: admin,
    request: { params: RunIdParam },
    responses: {
      200: {
        description: 'Status per batch handle',
        content: {
          'application/json': {
            schema: z.object({
              batches: z.array(
                z.object({
                  handle: z.string(),
                  status: z.string(),
                  errorsTotal: z.number(),
                  errors: z.array(z.object({ id: z.string(), message: z.string() })),
                  invalidIds: z.array(z.string()),
                }),
              ),
            }),
          },
        },
      },
      ...unauthorized,
      ...notFound,
      422: { description: 'Run has no Meta pushes, or the site has no Meta connection', content: { 'application/json': { schema: ErrorSchema } } },
      502: { description: 'Meta returned an error', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { runId } = c.req.valid('param');
    const run = await getRun(c.env.DB, runId);
    if (!run) return c.json({ error: 'run not found' }, 404);
    const meta = z.object({ handles: z.array(z.string()) }).safeParse(run.notes['meta']);
    if (!meta.success || meta.data.handles.length === 0) return c.json({ error: 'this run sent nothing to Meta' }, 422);
    const site = await getSite(c.env.DB, run.siteId);
    const tokenEnc = site ? await getMetaTokenEnc(c.env.DB, site.id) : null;
    if (!site?.metaCatalogId || !tokenEnc) return c.json({ error: 'site has no Meta connection' }, 422);
    const target = { catalogId: site.metaCatalogId, token: await decryptSecret(tokenEnc, c.env.TOKEN_ENC_KEY), graphVersion: c.env.META_GRAPH_VERSION };
    try {
      const batches = [];
      for (const handle of meta.data.handles.slice(0, 20)) batches.push(await checkBatchStatus(target, handle));
      return c.json({ batches }, 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  },
);

app.openapi(
  createRoute({
    method: 'get',
    path: '/admin/sites/{siteId}/changes',
    tags: ['Runs'],
    summary: 'Recent variant changes',
    security: admin,
    request: { params: SiteIdParam, query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }) },
    responses: {
      200: {
        description: 'Changes, newest first',
        content: {
          'application/json': {
            schema: z.object({
              changes: z.array(z.object({ id: z.number(), runId: z.string(), variantId: z.string(), kind: z.string(), fields: z.array(z.string()), createdAt: z.string(), pushedAt: z.string().nullable() })),
            }),
          },
        },
      },
      ...unauthorized,
    },
  }),
  async (c) => {
    const { siteId } = c.req.valid('param');
    const { limit } = c.req.valid('query');
    const rows = await listChanges(c.env.DB, siteId, limit);
    return c.json(
      {
        changes: rows.map((r) => ({ id: r.id, runId: r.run_id, variantId: r.variant_id, kind: r.kind, fields: r.fields ? r.fields.split(',') : [], createdAt: r.created_at, pushedAt: r.pushed_at })),
      },
      200,
    );
  },
);

app.openapi(
  createRoute({
    method: 'post',
    path: '/admin/sites/{siteId}/preview',
    tags: ['Sites'],
    summary: 'Read one product page without saving',
    description: 'For onboarding a site: shows exactly what the adapter extracts from a product URL on that site.',
    security: admin,
    request: { params: SiteIdParam, body: { content: { 'application/json': { schema: z.object({ url: z.string().max(2000) }) } } } },
    responses: {
      200: {
        description: 'What the adapter read',
        content: {
          'application/json': {
            schema: z.object({
              kind: z.enum(['ok', 'gone', 'not_product', 'error']),
              variants: z.array(VariantSchema).optional(),
              message: z.string().optional(),
            }),
          },
        },
      },
      ...invalid,
      ...unauthorized,
      ...notFound,
      422: { description: 'URL is not a product page on this site', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { siteId } = c.req.valid('param');
    const { url } = c.req.valid('json');
    const site = await getSite(c.env.DB, siteId);
    if (!site) return c.json({ error: 'site not found' }, 404);
    const parsed = parsePublicHttpsUrl(url);
    if (!parsed || !siteHosts(site.baseUrl).has(parsed.hostname.toLowerCase())) return c.json({ error: 'URL must be on this site' }, 422);
    const adapter = adapterFor(site.platform);
    const ref = adapter.refFromUrl(parsed.toString(), site);
    if (!ref) return c.json({ error: 'not a product page URL for this platform' }, 422);
    const result = await adapter.read(ref, { site, http: httpFor(site, c.env) });
    switch (result.kind) {
      case 'ok':
        return c.json({ kind: 'ok' as const, variants: result.variants }, 200);
      case 'gone':
        return c.json({ kind: 'gone' as const, message: result.reason }, 200);
      case 'not_product':
        return c.json({ kind: 'not_product' as const }, 200);
      case 'error':
        return c.json({ kind: 'error' as const, message: result.message }, 200);
      default: {
        const unreachable: never = result;
        throw new Error(`unhandled read result ${JSON.stringify(unreachable)}`);
      }
    }
  },
);

// ---------- feed ----------

app.openapi(
  createRoute({
    method: 'get',
    path: '/feeds/{siteId}/meta.csv',
    tags: ['Feeds'],
    summary: 'Meta catalog feed (CSV)',
    description: `Latest published feed. HTTP Basic auth: user = site ID, password = the site's feed password. Use as a scheduled feed URL in Commerce Manager. Availability values: ${AVAILABILITIES.join(', ')}.`,
    security: [{ FeedBasic: [] }],
    request: { params: SiteIdParam },
    responses: {
      200: { description: 'CSV feed', content: { 'text/csv': { schema: z.string() } } },
      401: { description: 'Missing or wrong feed credentials', content: { 'application/json': { schema: ErrorSchema } } },
      404: { description: 'No feed published yet', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { siteId } = c.req.valid('param');
    const creds = basicCredentials(c.req.header('authorization'));
    const hash = await getFeedPasswordHash(c.env.DB, siteId);
    // Same response for unknown site and wrong password, so site IDs can't be probed.
    const valid = creds !== null && hash !== null && creds.user === siteId && (await safeEqual(await sha256Hex(creds.password), hash));
    if (!valid) {
      c.header('WWW-Authenticate', 'Basic realm="feedsmith", charset="UTF-8"');
      return c.json({ error: 'unauthorized' }, 401);
    }
    const object = await c.env.FEEDS.get(feedKey(siteId));
    if (!object) return c.json({ error: 'no feed published yet' }, 404);
    return c.body(object.body, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'cache-control': 'private, no-store',
      'last-modified': object.uploaded.toUTCString(),
      'x-feed-items': object.customMetadata?.['items'] ?? '',
    });
  },
);

// ---------- docs ----------

app.openAPIRegistry.registerComponent('securitySchemes', 'AdminToken', { type: 'http', scheme: 'bearer', description: 'ADMIN_TOKEN secret' });
app.openAPIRegistry.registerComponent('securitySchemes', 'FeedBasic', { type: 'http', scheme: 'basic', description: 'site ID and feed password' });

app.doc31('/openapi.json', {
  openapi: '3.1.0',
  info: {
    title: 'Feedsmith',
    version: '0.1.0',
    description: 'Crawls storefronts that have no feed export and publishes Meta catalog feeds, with stock and price changes pushed to the Meta Batch API.',
  },
});
app.get('/docs', Scalar({ url: '/openapi.json', pageTitle: 'Feedsmith API' }));

// Anything else is a real 404, never a fallback page.
app.notFound((c) => c.json({ error: 'not found' }, 404));
app.onError((err, c) => {
  console.error(JSON.stringify({ event: 'unhandled_error', path: new URL(c.req.url).pathname, message: err.message }));
  return c.json({ error: 'internal error' }, 500);
});
