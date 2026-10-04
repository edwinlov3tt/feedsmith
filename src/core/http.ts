// Outbound fetching for crawls. Every request is bounded (timeout, body size,
// redirects) and confined to the site being crawled, so a hostile or
// misconfigured storefront can't point the crawler somewhere else.

export interface HttpOptions {
  /** Hosts the crawler may request. Redirects outside this set are refused. */
  allowedHosts: ReadonlySet<string>;
  userAgent: string;
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
}

export type FetchTextResult =
  | { ok: true; status: number; url: string; text: string; contentType: string }
  | { ok: false; status: number; url: string; error: string };

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 8_000_000;
const MAX_REDIRECTS = 4;

/** Public https URL on a non-IP host. Used for anything an admin supplies. */
export function parsePublicHttpsUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  // A trailing dot is the same host to DNS ("localhost." is localhost).
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return null;
  }
  // IPv4 literals, IPv6 literals: storefronts are always named hosts.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')) return null;
  if (!host.includes('.')) return null;
  return url;
}

/** The host plus its www/apex twin, which storefronts redirect between. */
export function siteHosts(baseUrl: string): Set<string> {
  const host = new URL(baseUrl).hostname.toLowerCase();
  const twin = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
  return new Set([host, twin]);
}

async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) return null;
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder('utf-8').decode(buf);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class HttpClient {
  readonly #opts: Required<Omit<HttpOptions, 'fetchImpl'>> & { fetchImpl: typeof fetch };
  requests = 0;

  constructor(opts: HttpOptions) {
    this.#opts = {
      allowedHosts: opts.allowedHosts,
      userAgent: opts.userAgent,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
      retries: opts.retries ?? 2,
      // Bound to globalThis: Workers throw "Illegal invocation" on a detached fetch.
      fetchImpl: opts.fetchImpl ?? fetch.bind(globalThis),
    };
  }

  #allowed(url: URL): boolean {
    return url.protocol === 'https:' && this.#opts.allowedHosts.has(url.hostname.toLowerCase());
  }

  async getText(raw: string): Promise<FetchTextResult> {
    let lastError = 'not attempted';
    let lastStatus = 0;
    for (let attempt = 0; attempt <= this.#opts.retries; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
      const result = await this.#once(raw);
      if (result.ok) return result;
      lastError = result.error;
      lastStatus = result.status;
      // Retry only what can plausibly succeed next time.
      const retryable = result.status === 0 || result.status === 429 || result.status >= 500;
      if (!retryable) return result;
    }
    return { ok: false, status: lastStatus, url: raw, error: lastError };
  }

  async #once(raw: string): Promise<FetchTextResult> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, status: 0, url: raw, error: 'invalid URL' };
    }
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!this.#allowed(url)) {
        return { ok: false, status: 0, url: url.toString(), error: `host not allowed: ${url.hostname}` };
      }
      this.requests++;
      let res: Response;
      try {
        res = await this.#opts.fetchImpl(url.toString(), {
          redirect: 'manual',
          headers: { 'user-agent': this.#opts.userAgent, accept: 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.5' },
          signal: AbortSignal.timeout(this.#opts.timeoutMs),
        });
      } catch (err) {
        return { ok: false, status: 0, url: url.toString(), error: err instanceof Error ? err.message : String(err) };
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel();
        if (!location) return { ok: false, status: res.status, url: url.toString(), error: 'redirect without location' };
        try {
          url = new URL(location, url);
        } catch {
          return { ok: false, status: res.status, url: url.toString(), error: 'malformed redirect location' };
        }
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        return { ok: false, status: res.status, url: url.toString(), error: `HTTP ${res.status}` };
      }
      let text: string | null;
      try {
        text = await readCapped(res, this.#opts.maxBytes);
      } catch (err) {
        // Body timeouts and resets surface here, after the headers arrived.
        return { ok: false, status: 0, url: url.toString(), error: `body read failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (text === null) return { ok: false, status: res.status, url: url.toString(), error: 'response too large' };
      return { ok: true, status: res.status, url: url.toString(), text, contentType: res.headers.get('content-type') ?? '' };
    }
    return { ok: false, status: 0, url: url.toString(), error: 'too many redirects' };
  }
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) return;
      out[i] = await fn(item, i);
    }
  });
  await Promise.all(workers);
  return out;
}
