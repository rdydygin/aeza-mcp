import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createApi, type Fetch } from "./api.ts";
import { buildOperations } from "./operations.ts";
import { createServer, selectOperations, type ServerOptions } from "./server.ts";
import type { Spec } from "./spec.ts";

const spec = (await Bun.file(new URL("../test/openapi.json", import.meta.url)).json()) as Spec;
const operations = buildOperations(spec);

/** Connects an MCP client to a server whose API calls are recorded and answered by `respond`. */
async function connect(respond: () => Response, options: Partial<ServerOptions> = {}) {
  const requests: Array<{ method: string; url: URL; headers: Record<string, string>; body: unknown }> = [];
  const fetch: Fetch = async (url, init) => {
    requests.push({
      method: init?.method ?? "GET",
      url: new URL(url),
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return respond();
  };
  const api = createApi({ baseUrl: "https://my.aeza.ru/api/v2", apiKey: "secret", fetch });
  const server = createServer({ operations, api, ...options });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, requests };
}

const text = (result: { content: unknown }) => (result.content as Array<{ type: string; text: string }>)[0]!.text;

test("selects tools by toolset and read-only mode", () => {
  const names = (selected: typeof operations) => selected.map((operation) => operation.name);
  expect(names(selectOperations(operations))).not.toContain("auth_tfa_use_totp");
  expect(selectOperations(operations, { toolsets: ["all"], allowDelete: true })).toHaveLength(operations.length);
  expect(new Set(selectOperations(operations, { toolsets: ["domains", "billing"] }).map((o) => o.toolset))).toEqual(
    new Set(["domains", "billing"]),
  );

  const readOnly = names(selectOperations(operations, { toolsets: ["all"], readOnly: true }));
  expect(readOnly).toContain("services_get_list");
  expect(readOnly).not.toContain("services_request_deletion");

  expect(() => selectOperations(operations, { toolsets: ["nope"] })).toThrow("Unknown toolset: nope");
});

test("exposes deletion tools only when explicitly allowed", () => {
  const deletions = (options: Partial<ServerOptions>) =>
    selectOperations(operations, { toolsets: ["all"], ...options }).filter((operation) => operation.method === "DELETE");

  expect(deletions({})).toHaveLength(0);
  expect(deletions({ allowDelete: false })).toHaveLength(0);
  expect(deletions({ allowDelete: true, readOnly: true })).toHaveLength(0);
  const allowed = deletions({ allowDelete: true }).map((operation) => operation.name);
  expect(allowed).toContain("services_request_deletion");
  expect(allowed).toContain("domains_delete_record");
  expect(allowed).toHaveLength(operations.filter((operation) => operation.method === "DELETE").length);

  // Everything else that changes the account stays available without the flag.
  expect(selectOperations(operations).map((operation) => operation.name)).toContain("domains_create_record");
});

test("tells the model when deletion is disabled", async () => {
  const instructions = async (options: Partial<ServerOptions>) => (await connect(() => Response.json({}), options)).client.getInstructions();
  expect(await instructions({})).toContain("AEZA_ALLOW_DELETE=1");
  expect(await instructions({ allowDelete: true })).not.toContain("AEZA_ALLOW_DELETE");
  expect(await instructions({ readOnly: true })).not.toContain("AEZA_ALLOW_DELETE");
});

test("lists every tool with its schema and annotations", async () => {
  const { client } = await connect(() => Response.json({}), { toolsets: ["all"], allowDelete: true });
  const listed = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools({ cursor });
    listed.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);

  expect(listed).toHaveLength(operations.length);
  const createRecord = listed.find((tool) => tool.name === "domains_create_record")!;
  expect(createRecord.inputSchema.required).toEqual(["domainId", "body"]);
  expect(createRecord.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  expect(listed.find((tool) => tool.name === "services_get_list")!.annotations).toMatchObject({
    readOnlyHint: true,
    destructiveHint: false,
  });
});

test("every tool's schema compiles and validates", async () => {
  // A schema the validator cannot compile only fails when its tool is called, so call them all.
  const { client, requests } = await connect(() => Response.json({}), { toolsets: ["all"], allowDelete: true });

  for (const operation of operations) {
    const result = await client.callTool({ name: operation.name, arguments: { unexpected: true } });
    expect(text(result)).toStartWith(`Input validation error: Invalid arguments for tool ${operation.name}:`);
    expect(text(result)).toContain("must NOT have additional properties");
  }
  expect(requests).toHaveLength(0);
});

test("calls the API with path, query and body arguments", async () => {
  const { client, requests } = await connect(() => Response.json({ id: 9, type: "A" }, { status: 201 }));

  const result = await client.callTool({
    name: "domains_create_record",
    arguments: { domainId: 5, body: { type: "A", name: "www", content: "192.0.2.1" } },
  });

  expect(result.isError).toBeFalsy();
  expect(JSON.parse(text(result))).toEqual({ id: 9, type: "A" });
  const request = requests[0]!;
  expect(`${request.method} ${request.url}`).toBe("POST https://my.aeza.ru/api/v2/domains/5/records");
  expect(request.headers["x-api-key"]).toBe("secret");
  expect(request.body).toEqual({ type: "A", name: "www", content: "192.0.2.1" });

  await client.callTool({
    name: "services_get_stats",
    arguments: { id: 1, statType: "cpu_usage", resolution: 60, fromDate: "2026-01-01T00:00:00Z", toDate: "2026-01-02T00:00:00+03:00" },
  });
  const stats = requests[1]!.url;
  expect(stats.pathname).toBe("/api/v2/services/1/stats/cpu_usage");
  expect(Object.fromEntries(stats.searchParams)).toEqual({
    resolution: "60",
    fromDate: "2026-01-01T00:00:00Z",
    toDate: "2026-01-02T00:00:00+03:00",
  });
});

test("rejects invalid arguments without calling the API", async () => {
  const { client, requests } = await connect(() => Response.json({}));

  const result = await client.callTool({ name: "services_get_by_id", arguments: { id: "not-a-number" } });

  expect(result.isError).toBe(true);
  expect(text(result)).toContain("id must be number");
  expect(requests).toHaveLength(0);
});

test("reports API errors as tool errors", async () => {
  const envelope = { statusCode: 401, message: "Not authenticated", error: "not_auth", payload: "Not authenticated" };
  const { client } = await connect(() => Response.json(envelope, { status: 401 }));

  const result = await client.callTool({ name: "accounts_get_account_info", arguments: {} });

  expect(result.isError).toBe(true);
  expect(text(result)).toBe("Aeza API error 401 not_auth Not authenticated\nSet AEZA_API_KEY to a valid Aeza API key.");
});

test("retries rate-limited requests", async () => {
  const responses = [new Response(null, { status: 429, headers: { "retry-after": "0.01" } }), Response.json({ items: [], total: 0 })];
  const { client, requests } = await connect(() => responses.shift()!);

  const result = await client.callTool({ name: "services_get_list", arguments: { limit: 5 } });

  expect(JSON.parse(text(result))).toEqual({ items: [], total: 0 });
  expect(requests.map((request) => request.url.search)).toEqual(["?offset=0&limit=5", "?offset=0&limit=5"]);
});

test("sends the documented defaults of query parameters the caller leaves out", async () => {
  // The API answers 500 to a price request without paymentTerm, although the spec gives it a default.
  const { client, requests } = await connect(() => Response.json({}));

  await client.callTool({ name: "services_orders_get_price", arguments: { productId: 7 } });
  await client.callTool({ name: "services_orders_get_price", arguments: { productId: 7, paymentTerm: "year" } });

  expect(requests.map((request) => request.url.search)).toEqual([
    "?paymentTerm=month&termCount=1&productId=7",
    "?paymentTerm=year&termCount=1&productId=7",
  ]);
});

test("says so when the API answers with an empty body", async () => {
  const { client } = await connect(() => new Response(null, { status: 204 }));

  const result = await client.callTool({ name: "services_get_by_id", arguments: { id: 1 } });

  expect(result.isError).toBeFalsy();
  expect(text(result)).toBe("OK (the API returned an empty response)");
});

test("truncates oversized lists at an item boundary", async () => {
  const items = Array.from({ length: 100 }, (_, id) => ({ id, name: "x".repeat(50) }));
  const { client } = await connect(() => Response.json({ items, total: 100 }), { maxOutputChars: 1000 });

  const result = await client.callTool({ name: "services_get_list", arguments: {} });

  const output = JSON.parse(text(result)) as { items: unknown[]; total: number; truncated: string };
  expect(output.total).toBe(100);
  expect(output.items.length).toBeGreaterThan(0);
  expect(output.items.length).toBeLessThan(100);
  expect(output.truncated).toStartWith(`Showing ${output.items.length} of 100 items`);
});
