import type { HttpClient } from '../core/http.ts';
import type { DiscoverResult, PlatformId, ProductRef, ReadResult } from '../core/model.ts';
import type { Site } from '../core/site.ts';

export interface AdapterContext {
  site: Site;
  http: HttpClient;
}

/**
 * Everything platform-specific lives behind this interface. Adding a platform
 * means writing one of these; the pipeline, diffing and feeds don't change.
 */
export interface Adapter {
  readonly id: PlatformId;
  /** True when a fetched homepage looks like this platform. */
  detect(html: string): boolean;
  /** Finds every product on the site. */
  discover(ctx: AdapterContext): Promise<DiscoverResult>;
  /** The ref for a product page URL, for previews. Null when the URL isn't a product page. */
  refFromUrl(url: string, site: Site): ProductRef | null;
  /** Reads one product into variants. Never throws for site-side problems. */
  read(ref: ProductRef, ctx: AdapterContext): Promise<ReadResult>;
}
