import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetch } from "./api.ts";
import { loadSpec, type Spec } from "./spec.ts";

const baseUrl = "https://api.test/v2";
const specOf = (version: string): Spec => ({ openapi: "3.0.0", info: { version }, paths: { [`/v${version}`]: {} } });

let cacheDir: string;
beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "aeza-mcp-"));
});
afterEach(() => rm(cacheDir, { recursive: true }));

/** An API that serves `version`, or is unreachable when `version` is undefined. */
function mockApi(version: string | undefined) {
  const requested: string[] = [];
  const fetch: Fetch = async (url) => {
    const path = String(url).slice(baseUrl.length);
    requested.push(path);
    if (version === undefined) throw new Error("network down");
    return path === "/version" ? new Response(`${version}\n`) : Response.json(specOf(version));
  };
  return { fetch, requested };
}

test("downloads the spec once and reuses it while the API version stays the same", async () => {
  const first = mockApi("100");
  expect(await loadSpec({ baseUrl, cacheDir, fetch: first.fetch })).toEqual(specOf("100"));
  expect(first.requested).toEqual(["/docs-json"]);
  expect(JSON.parse(await readFile(join(cacheDir, "api.test.json"), "utf8"))).toEqual(specOf("100"));

  const second = mockApi("100");
  expect(await loadSpec({ baseUrl, cacheDir, fetch: second.fetch })).toEqual(specOf("100"));
  expect(second.requested).toEqual(["/version"]);
});

test("downloads the spec again when the API version changes", async () => {
  await loadSpec({ baseUrl, cacheDir, fetch: mockApi("100").fetch });
  const updated = mockApi("101");
  const log: string[] = [];

  const spec = await loadSpec({ baseUrl, cacheDir, fetch: updated.fetch, log: (message) => log.push(message) });

  expect(spec).toEqual(specOf("101"));
  expect(updated.requested).toEqual(["/version", "/docs-json"]);
  expect(log).toEqual(["API spec updated: 100 -> 101"]);
  expect(JSON.parse(await readFile(join(cacheDir, "api.test.json"), "utf8"))).toEqual(specOf("101"));
});

test("falls back to the cached spec when the API is unreachable", async () => {
  await loadSpec({ baseUrl, cacheDir, fetch: mockApi("100").fetch });
  const log: string[] = [];

  const spec = await loadSpec({ baseUrl, cacheDir, fetch: mockApi(undefined).fetch, log: (message) => log.push(message) });

  expect(spec).toEqual(specOf("100"));
  expect(log).toEqual(["cannot refresh the API spec (network down), using cached version 100"]);
});

test("fails when there is neither a cache nor a reachable API", async () => {
  expect(loadSpec({ baseUrl, cacheDir, fetch: mockApi(undefined).fetch })).rejects.toThrow(
    "Cannot load the API spec from https://api.test/v2: network down",
  );
});
