import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { adapterFor, catalogTypeOf, detectPlatform } from '../adapters/registry.ts';
import { decryptSecret, encryptSecret, randomToken, safeEqual, sha256Hex } from '../core/crypto.ts';
import { HttpClient, parsePublicHttpsUrl, siteHosts } from '../core/http.ts';
import { AVAILABILITIES, CATALOG_TYPES, PLATFORMS, VariantSchema } from '../core/model.ts';
import { SiteConfigPatchSchema, SiteConfigSchema, SiteIdSchema, validatePatterns, type Site } from '../core/site.ts';
import { CatalogIdSchema, checkBatchStatus, verifyCatalogAccess } from '../pipeline/meta.ts';
import { feedKey } from '../pipeline/publish.ts';
import { httpFor, startRun } from '../pipeline/run.ts';
import { countSets, defaultSetDefinitions, metaTargetFor, setCsv, setItems, storedFilter, syncSet, unsyncSet } from '../pipeline/sets.ts';
import { parseSetFilter, SET_FIELDS, toMetaFilter, VEHICLE_SET_FIELDS } from '../core/set-filter.ts';
import {
  deleteSet,
  getClient,
  getFeedPasswordHash,
  getMetaTokenEnc,
  getSet,
  insertClient,
  listClients,
  listSets,
  setSiteClient,
  updateClient,
  upsertSet,
  type Client,
  type StoredSet,
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
    catalogType: z.enum(CATALOG_TYPES),
    config: z.record(z.string(), z.unknown()),
    metaCatalogId: z.string().nullable(),
    metaConnected: z.boolean(),
    clientId: z.string().nullable(),
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
    catalogType: catalogTypeOf(site.platform),
    config: site.config,
    metaCatalogId: site.metaCatalogId,
    metaConnected: site.hasMetaToken,
    clientId: site.clientId,
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

/** Feed URLs use HTTP Basic: user = site ID, password = the site's feed password. */
async function feedAuthorized(db: D1Database, siteId: string, header: string | undefined): Promise<boolean> {
  const creds = basicCredentials(header);
  const hash = await getFeedPasswordHash(db, siteId);
  // Same answer for unknown site and wrong password, so site IDs can't be probed.
  return creds !== null && hash !== null && creds.user === siteId && (await safeEqual(await sha256Hex(creds.password), hash));
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
              clientId: SiteIdSchema.optional(),
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
    const bad = patternError(SiteConfigSchema.parse(body.config ?? {}));
    if (bad) return c.json({ error: bad }, 422);
    if (await getSite(c.env.DB, body.id)) return c.json({ error: 'site ID already exists' }, 409);
    if (body.clientId && !(await getClient(c.env.DB, body.clientId))) return c.json({ error: 'client not found; create it first' }, 422);

    let platform = body.platform ?? null;
    if (!platform) {
      const http = new HttpClient({ allowedHosts: siteHosts(baseUrl), userAgent: c.env.USER_AGENT });
      const home = await http.getText(baseUrl);
      if (!home.ok) return c.json({ error: `could not fetch the site: ${home.error}` }, 422);
      platform = detectPlatform(home.text);
      if (!platform) return c.json({ error: 'no supported platform detected; pass platform explicitly or add an adapter' }, 422);
    }
    // Vehicles sell one at a time and their pages then 404, so a dealer's
    // normal day reports far more "gone" items than a store. The gate still
    // trips on a site-wide outage.
    const typeDefaults = catalogTypeOf(platform) === 'vehicles' ? { maxGoneRate: 0.3, maxSoldOutRate: 0.3 } : {};
    const config = SiteConfigSchema.parse({ ...typeDefaults, ...(body.config ?? {}) });
    const site: Site = { id: body.id, name: body.name, baseUrl, platform, config, metaCatalogId: null, lastDiscoveryCount: null };
    const feedPassword = randomToken();
    await insertSite(c.env.DB, site, await sha256Hex(feedPassword));
    if (body.clientId) await setSiteClient(c.env.DB, site.id, body.clientId);
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
    if (!(await feedAuthorized(c.env.DB, siteId, c.req.header('authorization')))) {
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

// ---------- clients ----------

const ClientSchema = z
  .object({ id: z.string(), name: z.string(), notes: z.string().nullable(), siteIds: z.array(z.string()), createdAt: z.string(), updatedAt: z.string() })
  .openapi('Client');
const ClientIdParam = z.object({ clientId: SiteIdSchema.openapi({ param: { name: 'clientId', in: 'path' }, example: 'ua-supply-store' }) });

async function clientDto(db: D1Database, client: Client): Promise<z.infer<typeof ClientSchema>> {
  const sites = await listSites(db);
  return { ...client, siteIds: sites.filter((s) => s.clientId === client.id).map((s) => s.id) };
}

app.openapi(
  createRoute({
    method: 'post',
    path: '/admin/clients',
    tags: ['Clients'],
    summary: 'Add a client',
    description: 'A client is the business Feedsmith runs feeds for. Sites (storefronts) belong to a client.',
    security: admin,
    request: { body: { content: { 'application/json': { schema: z.object({ id: SiteIdSchema, name: z.string().trim().min(1).max(200), notes: z.string().trim().max(2000).optional() }).strict() } } } },
    responses: { 201: { description: 'Created', content: { 'application/json': { schema: z.object({ client: ClientSchema }) } } }, ...invalid, ...unauthorized, 409: { description: 'Client ID taken', content: { 'application/json': { schema: ErrorSchema } } } },
  }),
  async (c) => {
    const body = c.req.valid('json');
    if (await getClient(c.env.DB, body.id)) return c.json({ error: 'client ID already exists' }, 409);
    await insertClient(c.env.DB, { id: body.id, name: body.name, notes: body.notes ?? null });
    const client = await getClient(c.env.DB, body.id);
    if (!client) throw new Error('client vanished after insert');
    return c.json({ client: await clientDto(c.env.DB, client) }, 201);
  },
);

app.openapi(
  createRoute({
    method: 'get',
    path: '/admin/clients',
    tags: ['Clients'],
    summary: 'List clients',
    security: admin,
    responses: { 200: { description: 'Clients', content: { 'application/json': { schema: z.object({ clients: z.array(ClientSchema) }) } } }, ...unauthorized },
  }),
  async (c) => {
    const sites = await listSites(c.env.DB);
    const clients = await listClients(c.env.DB);
    return c.json({ clients: clients.map((cl) => ({ ...cl, siteIds: sites.filter((s) => s.clientId === cl.id).map((s) => s.id) })) }, 200);
  },
);

app.openapi(
  createRoute({
    method: 'get',
    path: '/admin/clients/{clientId}',
    tags: ['Clients'],
    summary: 'A client with its sites',
    security: admin,
    request: { params: ClientIdParam },
    responses: {
      200: { description: 'Client', content: { 'application/json': { schema: z.object({ client: ClientSchema, sites: z.array(SiteSchema) }) } } },
      ...unauthorized,
      ...notFound,
    },
  }),
  async (c) => {
    const { clientId } = c.req.valid('param');
    const client = await getClient(c.env.DB, clientId);
    if (!client) return c.json({ error: 'client not found' }, 404);
    const origin = new URL(c.req.url).origin;
    const sites = (await listSites(c.env.DB)).filter((s) => s.clientId === clientId);
    return c.json({ client: { ...client, siteIds: sites.map((s) => s.id) }, sites: sites.map((s) => siteDto(s, origin)) }, 200);
  },
);

app.openapi(
  createRoute({
    method: 'patch',
    path: '/admin/clients/{clientId}',
    tags: ['Clients'],
    summary: 'Rename a client or edit notes',
    security: admin,
    request: { params: ClientIdParam, body: { content: { 'application/json': { schema: z.object({ name: z.string().trim().min(1).max(200).optional(), notes: z.string().trim().max(2000).nullable().optional() }).strict() } } } },
    responses: { 200: { description: 'Updated', content: { 'application/json': { schema: z.object({ client: ClientSchema }) } } }, ...invalid, ...unauthorized, ...notFound },
  }),
  async (c) => {
    const { clientId } = c.req.valid('param');
    const body = c.req.valid('json');
    const client = await getClient(c.env.DB, clientId);
    if (!client) return c.json({ error: 'client not found' }, 404);
    await updateClient(c.env.DB, clientId, body.name ?? client.name, body.notes === undefined ? client.notes : body.notes);
    const saved = await getClient(c.env.DB, clientId);
    if (!saved) return c.json({ error: 'client not found' }, 404);
    return c.json({ client: await clientDto(c.env.DB, saved) }, 200);
  },
);

app.openapi(
  createRoute({
    method: 'put',
    path: '/admin/sites/{siteId}/client',
    tags: ['Clients'],
    summary: 'Assign a site to a client (or unassign with null)',
    security: admin,
    request: { params: SiteIdParam, body: { content: { 'application/json': { schema: z.object({ clientId: SiteIdSchema.nullable() }).strict() } } } },
    responses: { 200: { description: 'Assigned', content: { 'application/json': { schema: z.object({ site: SiteSchema }) } } }, ...invalid, ...unauthorized, ...notFound, 422: { description: 'Unknown client', content: { 'application/json': { schema: ErrorSchema } } } },
  }),
  async (c) => {
    const { siteId } = c.req.valid('param');
    const { clientId } = c.req.valid('json');
    if (!(await getSite(c.env.DB, siteId))) return c.json({ error: 'site not found' }, 404);
    if (clientId && !(await getClient(c.env.DB, clientId))) return c.json({ error: 'client not found' }, 422);
    await setSiteClient(c.env.DB, siteId, clientId);
    const saved = await getSite(c.env.DB, siteId);
    if (!saved) return c.json({ error: 'site not found' }, 404);
    return c.json({ site: siteDto(saved, new URL(c.req.url).origin) }, 200);
  },
);

// ---------- product sets ----------

const SetSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'lowercase letters, digits and dashes, up to 48 chars');
const SetParams = z.object({
  siteId: SiteIdSchema.openapi({ param: { name: 'siteId', in: 'path' }, example: 'supe-store' }),
  slug: SetSlugSchema.openapi({ param: { name: 'slug', in: 'path' }, example: 'womens' }),
});
const FilterJson = z
  .record(z.string(), z.unknown())
  .openapi({
    description: `Meta product set filter JSON. Product catalog fields: ${SET_FIELDS.join(', ')}. Vehicle catalog fields: ${VEHICLE_SET_FIELDS.join(', ')} (year is numeric). Combine with {"and": [...]} / {"or": [...]}. Operators: eq, neq, contains, not_contains, i_contains, i_not_contains, is_any, is_not_any; price_amount (cents) takes lt, lte, gt, gte. {} matches everything.`,
    example: { and: [{ availability: { eq: 'in stock' } }, { gender: { eq: 'female' } }] },
  });
const ProductSetSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    filter: z.unknown(),
    items: z.number(),
    feedUrl: z.string(),
    metaSetId: z.string().nullable(),
    metaSyncedAt: z.string().nullable(),
    metaError: z.string().nullable(),
    updatedAt: z.string(),
  })
  .openapi('ProductSet');
const SyncOutcomeSchema = z.object({ slug: z.string(), ok: z.boolean(), action: z.string().optional(), metaSetId: z.string().optional(), error: z.string().optional() });

function setDto(set: StoredSet, items: number, origin: string): z.infer<typeof ProductSetSchema> {
  return {
    slug: set.slug,
    name: set.name,
    filter: set.filter,
    items,
    feedUrl: `${origin}/feeds/${set.siteId}/sets/${set.slug}/meta.csv`,
    metaSetId: set.metaSetId,
    metaSyncedAt: set.metaSyncedAt,
    metaError: set.metaError,
    updatedAt: set.updatedAt,
  };
}

function outcomeDto(o: Awaited<ReturnType<typeof syncSet>>): z.infer<typeof SyncOutcomeSchema> {
  return o.ok ? { slug: o.slug, ok: true, action: o.result.action, metaSetId: o.result.metaSetId } : { slug: o.slug, ok: false, error: o.error };
}

app.openapi(
  createRoute({
    method: 'get',
    path: '/admin/sites/{siteId}/product-sets',
    tags: ['Product sets'],
    summary: "A site's product sets with live item counts",
    security: admin,
    request: { params: SiteIdParam },
    responses: { 200: { description: 'Sets', content: { 'application/json': { schema: z.object({ sets: z.array(ProductSetSchema) }) } } }, ...unauthorized, ...notFound },
  }),
  async (c) => {
    const { siteId } = c.req.valid('param');
    const site = await getSite(c.env.DB, siteId);
    if (!site) return c.json({ error: 'site not found' }, 404);
    const sets = await listSets(c.env.DB, siteId);
    const counts = await countSets(c.env.DB, siteId, catalogTypeOf(site.platform), sets);
    const origin = new URL(c.req.url).origin;
    return c.json({ sets: sets.map((s) => setDto(s, counts.get(s.slug) ?? 0, origin)) }, 200);
  },
);

app.openapi(
  createRoute({
    method: 'put',
    path: '/admin/sites/{siteId}/product-sets/{slug}',
    tags: ['Product sets'],
    summary: 'Create or update a product set',
    description: "Saves the set, then syncs it to the site's Meta catalog when one is connected. Sets are filters, so they stay current as the feed changes.",
    security: admin,
    request: { params: SetParams, body: { content: { 'application/json': { schema: z.object({ name: z.string().trim().min(1).max(200), filter: FilterJson }).strict() } } } },
    responses: {
      200: { description: 'Saved', content: { 'application/json': { schema: z.object({ set: ProductSetSchema, meta: SyncOutcomeSchema.nullable() }) } } },
      ...invalid,
      ...unauthorized,
      ...notFound,
      422: { description: 'Invalid filter', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { siteId, slug } = c.req.valid('param');
    const { name, filter } = c.req.valid('json');
    const site = await getSite(c.env.DB, siteId);
    if (!site) return c.json({ error: 'site not found' }, 404);
    const type = catalogTypeOf(site.platform);
    const parsed = parseSetFilter(filter, type);
    if (!parsed.ok) return c.json({ error: parsed.error }, 422);
    await upsertSet(c.env.DB, siteId, slug, name, toMetaFilter(parsed.filter));
    const target = await metaTargetFor(c.env, site);
    let saved = await getSet(c.env.DB, siteId, slug);
    if (!saved) throw new Error('set vanished after save');
    const meta = target ? outcomeDto(await syncSet(c.env, siteId, type, target, saved)) : null;
    saved = (await getSet(c.env.DB, siteId, slug)) ?? saved;
    const counts = await countSets(c.env.DB, siteId, type, [saved]);
    return c.json({ set: setDto(saved, counts.get(slug) ?? 0, new URL(c.req.url).origin), meta }, 200);
  },
);

app.openapi(
  createRoute({
    method: 'delete',
    path: '/admin/sites/{siteId}/product-sets/{slug}',
    tags: ['Product sets'],
    summary: 'Delete a product set (here and on Meta)',
    description: 'Meta refuses to delete a set that live ads use; the error is returned and the set is kept.',
    security: admin,
    request: { params: SetParams },
    responses: { 204: { description: 'Deleted' }, ...unauthorized, ...notFound, 502: { description: 'Meta refused the delete', content: { 'application/json': { schema: ErrorSchema } } } },
  }),
  async (c) => {
    const { siteId, slug } = c.req.valid('param');
    const site = await getSite(c.env.DB, siteId);
    const set = site ? await getSet(c.env.DB, siteId, slug) : null;
    if (!site || !set) return c.json({ error: 'set not found' }, 404);
    const target = await metaTargetFor(c.env, site);
    if (target && set.metaSetId) {
      try {
        await unsyncSet(target, set);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
      }
    }
    await deleteSet(c.env.DB, siteId, slug);
    return c.body(null, 204);
  },
);

app.openapi(
  createRoute({
    method: 'post',
    path: '/admin/sites/{siteId}/product-sets/defaults',
    tags: ['Product sets'],
    summary: 'Create the recommended sets from labels in the feed',
    description:
      'All in stock (excluding clearance), one per department, Women\'s, Kids and Clearance, based on what the current feed contains. Existing slugs are left untouched unless overwrite=true. Syncs to Meta when connected.',
    security: admin,
    request: { params: SiteIdParam, query: z.object({ overwrite: z.enum(['true', 'false']).default('false') }) },
    responses: {
      200: {
        description: 'Created sets',
        content: { 'application/json': { schema: z.object({ created: z.array(z.string()), skipped: z.array(z.string()), meta: z.array(SyncOutcomeSchema) }) } },
      },
      ...unauthorized,
      ...notFound,
    },
  }),
  async (c) => {
    const { siteId } = c.req.valid('param');
    const { overwrite } = c.req.valid('query');
    const site = await getSite(c.env.DB, siteId);
    if (!site) return c.json({ error: 'site not found' }, 404);
    const existing = new Set((await listSets(c.env.DB, siteId)).map((s) => s.slug));
    const created: string[] = [];
    const skipped: string[] = [];
    const type = catalogTypeOf(site.platform);
    for (const def of await defaultSetDefinitions(c.env.DB, siteId, type)) {
      if (existing.has(def.slug) && overwrite !== 'true') {
        skipped.push(def.slug);
        continue;
      }
      await upsertSet(c.env.DB, siteId, def.slug, def.name, def.filter);
      created.push(def.slug);
    }
    const target = await metaTargetFor(c.env, site);
    const meta: Array<z.infer<typeof SyncOutcomeSchema>> = [];
    if (target) {
      for (const set of await listSets(c.env.DB, siteId)) if (created.includes(set.slug)) meta.push(outcomeDto(await syncSet(c.env, siteId, type, target, set)));
    }
    return c.json({ created, skipped, meta }, 200);
  },
);

app.openapi(
  createRoute({
    method: 'post',
    path: '/admin/sites/{siteId}/product-sets/sync',
    tags: ['Product sets'],
    summary: "Push every set to the site's Meta catalog",
    description: 'Creates sets Meta does not have yet (or re-finds ones Feedsmith created before) and updates the rest.',
    security: admin,
    request: { params: SiteIdParam },
    responses: {
      200: { description: 'Per-set results', content: { 'application/json': { schema: z.object({ results: z.array(SyncOutcomeSchema) }) } } },
      ...unauthorized,
      ...notFound,
      422: { description: 'No Meta connection', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { siteId } = c.req.valid('param');
    const site = await getSite(c.env.DB, siteId);
    if (!site) return c.json({ error: 'site not found' }, 404);
    const target = await metaTargetFor(c.env, site);
    if (!target) return c.json({ error: 'site has no Meta connection' }, 422);
    const results = [];
    for (const set of await listSets(c.env.DB, siteId)) results.push(outcomeDto(await syncSet(c.env, siteId, catalogTypeOf(site.platform), target, set)));
    return c.json({ results }, 200);
  },
);

app.openapi(
  createRoute({
    method: 'get',
    path: '/admin/sites/{siteId}/product-sets/{slug}/items',
    tags: ['Product sets'],
    summary: "A set's items (feed rows), paged",
    security: admin,
    request: { params: SetParams, query: z.object({ limit: z.coerce.number().int().min(1).max(1000).default(100), after: z.string().max(100).optional() }) },
    responses: {
      200: {
        description: 'Items ordered by id; pass next as after for the following page',
        content: { 'application/json': { schema: z.object({ items: z.array(z.record(z.string(), z.string())), next: z.string().nullable() }) } },
      },
      ...unauthorized,
      ...notFound,
    },
  }),
  async (c) => {
    const { siteId, slug } = c.req.valid('param');
    const { limit, after } = c.req.valid('query');
    const site = await getSite(c.env.DB, siteId);
    const set = site ? await getSet(c.env.DB, siteId, slug) : null;
    const filter = site && set ? storedFilter(set, catalogTypeOf(site.platform)) : null;
    if (!set || !filter) return c.json({ error: 'set not found' }, 404);
    return c.json(await setItems(c.env.DB, siteId, filter, limit, after ?? null), 200);
  },
);

app.openapi(
  createRoute({
    method: 'get',
    path: '/feeds/{siteId}/sets/{slug}/meta.csv',
    tags: ['Feeds'],
    summary: 'One product set as its own feed (CSV)',
    description: "Only the set's items, in the same format as the full feed and with the same feed password.",
    security: [{ FeedBasic: [] }],
    request: { params: SetParams },
    responses: {
      200: { description: 'CSV feed', content: { 'text/csv': { schema: z.string() } } },
      401: { description: 'Missing or wrong feed credentials', content: { 'application/json': { schema: ErrorSchema } } },
      404: { description: 'No such set', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { siteId, slug } = c.req.valid('param');
    if (!(await feedAuthorized(c.env.DB, siteId, c.req.header('authorization')))) {
      c.header('WWW-Authenticate', 'Basic realm="feedsmith", charset="UTF-8"');
      return c.json({ error: 'unauthorized' }, 401);
    }
    const site = await getSite(c.env.DB, siteId);
    const set = site ? await getSet(c.env.DB, siteId, slug) : null;
    const type = site ? catalogTypeOf(site.platform) : 'commerce';
    const filter = set ? storedFilter(set, type) : null;
    if (!set || !filter) return c.json({ error: 'set not found' }, 404);
    const { body, items } = await setCsv(c.env.DB, siteId, type, filter);
    return c.body(body, 200, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'private, no-store', 'x-feed-items': String(items) });
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
