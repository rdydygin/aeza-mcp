/** The API answered with a non-2xx status. */
export class AezaError extends Error {
  override name = "AezaError";
  readonly status: number;
  /** Machine-readable error slug such as `not_auth` (catalog: `GET /errors`). */
  readonly code: string | undefined;
  /** Error details, the `payload` field of the API's error envelope. */
  readonly payload: unknown;

  constructor(response: Response, body: unknown) {
    const envelope = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const code = typeof envelope.error === "string" ? envelope.error : undefined;
    const message = Array.isArray(envelope.message) ? envelope.message.join("; ") : envelope.message;
    super([response.status, code, typeof message === "string" ? message : response.statusText].filter(Boolean).join(" "));
    this.status = response.status;
    this.code = code;
    this.payload = envelope.payload;
  }
}

/** The part of `fetch` this server uses, so a stand-in is a plain function. */
export type Fetch = (url: URL | string, init?: RequestInit) => Promise<Response>;

export interface ApiOptions {
  baseUrl: string;
  /** Sent as the `x-api-key` header. */
  apiKey?: string;
  fetch?: Fetch;
  /** How many times a rate-limited (429) request is retried. Default: 2. */
  maxRetries?: number;
}

export interface ApiRequest {
  method: string;
  /** Path template relative to the base URL, e.g. `/services/{id}`. */
  path: string;
  pathParams?: Record<string, unknown>;
  /** `null`/`undefined` are skipped, arrays repeat the key, objects are sent as JSON. */
  query?: Record<string, unknown>;
  /** JSON request body. */
  body?: unknown;
}

export type Api = (request: ApiRequest) => Promise<unknown>;

const TIMEOUT = 60_000;

export function createApi({ baseUrl, apiKey, fetch = globalThis.fetch, maxRetries = 2 }: ApiOptions): Api {
  return async ({ method, path, pathParams = {}, query = {}, body }) => {
    const url = new URL(baseUrl + path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(String(pathParams[name]))));
    for (const [key, value] of Object.entries(query)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item === undefined || item === null) continue;
        url.searchParams.append(key, typeof item === "object" ? JSON.stringify(item) : String(item));
      }
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) headers["x-api-key"] = apiKey;
    if (body !== undefined) headers["content-type"] = "application/json";
    const payload = body === undefined ? undefined : JSON.stringify(body);

    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(TIMEOUT) });
      // The API allows 10 requests per second. A 429 was not processed, so any method is safe to retry.
      if (response.status === 429 && attempt < maxRetries) {
        const seconds = Number(response.headers.get("retry-after") ?? response.headers.get("x-ratelimit-reset"));
        await new Promise((resolve) => setTimeout(resolve, seconds > 0 ? Math.min(seconds, 30) * 1000 : 1000));
        continue;
      }
      const data = parse(response, await response.text());
      if (!response.ok) throw new AezaError(response, data);
      return data;
    }
  };
}

/** An empty body is `undefined`, which keeps it apart from a JSON `null`. */
function parse(response: Response, text: string): unknown {
  if (text === "") return undefined;
  if (!response.headers.get("content-type")?.includes("json")) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
