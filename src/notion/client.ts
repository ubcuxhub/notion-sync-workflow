/**
 * Minimal Notion REST client.
 *
 * Pinned to API version 2025-09-03, which is the data-source model: a database
 * is a container whose `data_sources[]` hold the actual property schema and
 * rows. Queries, schema reads and page parents all address a *data source* id,
 * not a database id. We keep database ids in config because those are the ones
 * a human can read off a Notion URL, and resolve them here once per process.
 */

const NOTION_VERSION = "2025-09-03";
const BASE = "https://api.notion.com/v1";

/** Notion allows ~3 requests/second averaged. Serialize with a little headroom. */
const MIN_INTERVAL_MS = 300;
const MAX_ATTEMPTS = 5;

export class NotionError extends Error {
  /** Set from the Retry-After header when Notion sends one. */
  retryAfterMs?: number;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NotionError";
  }
}

const RETRYABLE_CODES = new Set(["rate_limited", "conflict_error", "internal_server_error", "service_unavailable"]);

function isRetryable(err: unknown): boolean {
  if (err instanceof NotionError) {
    return err.status === 429 || err.status >= 500 || RETRYABLE_CODES.has(err.code);
  }
  // Network-level failures (DNS, socket resets) are worth another try.
  return err instanceof TypeError;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class NotionClient {
  #token: string;
  /** All requests funnel through this chain so spacing is actually enforced. */
  #queue: Promise<unknown> = Promise.resolve();
  #lastRequestAt = 0;
  #dataSourceCache = new Map<string, string>();

  constructor(token: string) {
    if (!token) throw new Error("NOTION_TOKEN is empty — set it in .env or as a secret");
    this.#token = token;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const run = async (): Promise<T> => {
      const wait = MIN_INTERVAL_MS - (Date.now() - this.#lastRequestAt);
      if (wait > 0) await sleep(wait);

      let lastError: unknown;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          return await this.#send<T>(method, path, body);
        } catch (err) {
          lastError = err;
          if (!isRetryable(err) || attempt === MAX_ATTEMPTS) throw err;

          // Honour Retry-After when Notion gives us one; otherwise back off.
          const retryAfter = err instanceof NotionError ? err.retryAfterMs : undefined;
          const backoff = retryAfter ?? 500 * 2 ** (attempt - 1) + Math.random() * 250;
          await sleep(backoff);
        }
      }
      throw lastError;
    };

    // Chain regardless of whether the previous call rejected.
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        "Notion-Version": NOTION_VERSION,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.#lastRequestAt = Date.now();

    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : {};

    if (!res.ok) {
      const e = json as { code?: string; message?: string };
      const err = new NotionError(res.status, e.code ?? "unknown", e.message ?? `${method} ${path} failed with ${res.status}`);
      const retryAfter = res.headers.get("retry-after");
      if (retryAfter) err.retryAfterMs = Number(retryAfter) * 1000;
      throw err;
    }
    return json as T;
  }

  /**
   * Resolve a database id to its data source id, cached for the process.
   *
   * A database can hold several data sources; sync targets one database each
   * for tickets and PRs, so anything beyond the first is a misconfiguration
   * worth failing loudly on rather than guessing about.
   */
  async dataSourceId(databaseId: string): Promise<string> {
    const cached = this.#dataSourceCache.get(databaseId);
    if (cached) return cached;

    const db = await this.request<{ data_sources?: { id: string; name: string }[] }>(
      "GET",
      `/databases/${databaseId}`,
    );
    const sources = db.data_sources ?? [];
    if (sources.length === 0) {
      throw new Error(
        `Database ${databaseId} reports no data sources. Either it is not shared with the integration, ` +
          `or the API version pin (${NOTION_VERSION}) no longer matches the workspace.`,
      );
    }
    if (sources.length > 1) {
      throw new Error(
        `Database ${databaseId} has ${sources.length} data sources (${sources.map((s) => s.name).join(", ")}). ` +
          `Sync expects exactly one.`,
      );
    }
    const id = sources[0]!.id;
    this.#dataSourceCache.set(databaseId, id);
    return id;
  }

  /** Walk every page of a data source query, applying `filter` and `sorts` as given. */
  async queryAll<T>(dataSourceId: string, query: Record<string, unknown> = {}): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request<{ results: T[]; has_more: boolean; next_cursor: string | null }>(
        "POST",
        `/data_sources/${dataSourceId}/query`,
        { ...query, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
      );
      out.push(...page.results);
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return out;
  }

  /** First match only — used for the by-URL and by-ticket-key lookups. */
  async queryOne<T>(dataSourceId: string, filter: Record<string, unknown>): Promise<T | undefined> {
    const page = await this.request<{ results: T[] }>("POST", `/data_sources/${dataSourceId}/query`, {
      filter,
      page_size: 1,
    });
    return page.results[0];
  }
}
