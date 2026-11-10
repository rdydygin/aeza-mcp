import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Fetch } from "./api.ts";

/** An OpenAPI 3.0 schema object, as far as this server reads it. */
export interface Schema {
  $ref?: string;
  type?: string;
  nullable?: boolean;
  description?: string;
  example?: unknown;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  additionalProperties?: boolean | Schema;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  [keyword: string]: unknown;
}

export interface SpecOperation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  deprecated?: boolean;
  parameters?: Array<{ name: string; in: string; required?: boolean; description?: string; schema?: Schema }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Schema }> };
}

export interface Spec {
  openapi: string;
  info: { version: string };
  paths: Record<string, Record<string, SpecOperation>>;
  components?: { schemas?: Record<string, Schema> };
}

export interface LoadSpecOptions {
  /** API root, e.g. `https://my.aeza.ru/api/v2`. The spec is served at `<baseUrl>/docs-json`. */
  baseUrl: string;
  /** Default: `$XDG_CACHE_HOME/aeza-mcp`, falling back to `~/.cache/aeza-mcp`. */
  cacheDir?: string;
  fetch?: Fetch;
  log?: (message: string) => void;
}

export const defaultCacheDir = () => join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "aeza-mcp");

/**
 * Returns the API's current OpenAPI spec, downloading it only when it changed.
 *
 * The docs endpoint has no ETag, but `GET /version` returns the same build number as the spec's
 * `info.version`, so one tiny request tells whether the cached copy is still current. When the
 * API cannot be reached, the cached copy is used as it is.
 */
export async function loadSpec({ baseUrl, cacheDir = defaultCacheDir(), fetch = globalThis.fetch, log = () => {} }: LoadSpecOptions): Promise<Spec> {
  const file = join(cacheDir, `${new URL(baseUrl).host}.json`);
  const cached = await readCache(file);
  const get = async (path: string, timeout: number) => {
    const response = await fetch(baseUrl + path, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`);
    return response.text();
  };

  let spec: unknown;
  try {
    if (cached && (await get("/version", 5_000)).trim() === cached.info.version) return cached;
    spec = JSON.parse(await get("/docs-json", 20_000));
    if (!isSpec(spec)) throw new Error("/docs-json is not an OpenAPI document");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!cached) throw new Error(`Cannot load the API spec from ${baseUrl}: ${reason}`, { cause: error });
    log(`cannot refresh the API spec (${reason}), using cached version ${cached.info.version}`);
    return cached;
  }

  log(cached ? `API spec updated: ${cached.info.version} -> ${spec.info.version}` : `API spec ${spec.info.version} downloaded`);
  try {
    // Several clients may start the server at once: write aside, then rename atomically.
    const temporary = `${file}.${process.pid}.tmp`;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(temporary, JSON.stringify(spec));
    await rename(temporary, file);
  } catch (error) {
    log(`cannot cache the API spec in ${cacheDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return spec;
}

async function readCache(file: string): Promise<Spec | undefined> {
  try {
    const spec: unknown = JSON.parse(await readFile(file, "utf8"));
    return isSpec(spec) ? spec : undefined;
  } catch {
    return undefined;
  }
}

function isSpec(value: unknown): value is Spec {
  const spec = value as Partial<Spec> | null;
  return typeof spec?.openapi === "string" && typeof spec.paths === "object" && typeof spec.info?.version === "string";
}
