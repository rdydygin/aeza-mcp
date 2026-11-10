import { expect, test } from "bun:test";
import { buildOperations, type JsonSchema, toolsets } from "./operations.ts";
import type { Spec } from "./spec.ts";

/** Snapshot of the real spec, so the conversion is tested against what upstream actually publishes. */
const spec = (await Bun.file(new URL("../test/openapi.json", import.meta.url)).json()) as Spec;
const skipped: string[] = [];
const operations = buildOperations(spec, (message) => skipped.push(message));
const find = (name: string) => operations.find((operation) => operation.name === name)!;
const properties = (schema: JsonSchema) => schema.properties as Record<string, JsonSchema>;

test("converts every operation of the real spec", () => {
  const total = Object.values(spec.paths).flatMap((item) => Object.keys(item)).length;
  expect(skipped).toEqual([]);
  expect(operations).toHaveLength(total);
  expect(new Set(operations.map((operation) => operation.name)).size).toBe(total);
  for (const { name } of operations) expect(name).toMatch(/^[a-z0-9_]{1,64}$/);
  // Schemas are self-contained and free of OpenAPI-only keywords.
  expect(JSON.stringify(operations)).not.toMatch(/"\$ref"|"nullable"|"example"/);
});

test("names tools after the API section and operation id", () => {
  expect(find("services_get_list").path).toBe("/services");
  expect(find("domains_get_list").path).toBe("/domains");
  // The controller prefix is dropped when it repeats the tag...
  expect(find("services_edit").path).toBe("/services/{id}");
  // ...and kept where it says more than the tag does.
  expect(find("auth_tfa_use_totp").path).toBe("/auth/tfa/totp");
  expect(find("accounts_security_confirmations_request").path).toBe("/accounts/me/security-confirmations");
});

test("sorts every tag of the real spec into a toolset", () => {
  for (const operation of operations) expect(toolsets).toContain(operation.toolset);
  expect(operations.filter((operation) => operation.toolset === "other")).toEqual([]);
  expect(find("services_reinstall").toolset).toBe("services");
  expect(find("auth_tfa_use_totp").toolset).toBe("internal");
});

test("marks lookups as read-only", () => {
  expect(find("services_get_list").readOnly).toBe(true);
  expect(find("domains_check_domain_available")).toMatchObject({ method: "POST", readOnly: true });
  expect(find("services_orders_create_order").readOnly).toBe(false);
  expect(find("services_request_deletion").readOnly).toBe(false);
});

test("flattens path and query parameters, nests the body", () => {
  const { inputSchema, pathParams } = find("services_get_stats");
  expect(pathParams).toEqual(["id", "statType"]);
  expect(inputSchema.required).toEqual(["id", "statType", "resolution", "fromDate", "toDate"]);
  expect(properties(inputSchema).statType!.enum).toContain("cpu_usage");
  expect(properties(inputSchema).fromDate).toEqual({ type: "string", format: "date-time" });

  const createRecord = find("domains_create_record").inputSchema;
  expect(createRecord.required).toEqual(["domainId", "body"]);
  const body = properties(createRecord).body!;
  expect(body.required).toEqual(["type", "name", "content"]);
  expect(properties(body).priority).toEqual({ type: ["number", "null"] });
  expect(properties(body).name!.description).toContain("Relative owner in zone");
});

test("repairs what the spec gets wrong", () => {
  // {recordId} is in the path but never declared as a parameter.
  expect(find("domains_edit_record").inputSchema.required).toEqual(["domainId", "recordId", "body"]);
  // Command arguments are declared as a bare string.
  expect(properties(find("services_send_command").inputSchema).body).toEqual({});
  // Undocumented operations still get a description.
  expect(find("domains_get_list").description).toBe("Domains get list\nGET /domains");
});

test("keeps going when an operation cannot be converted", () => {
  const broken: Spec = {
    openapi: "3.0.0",
    info: { version: "1" },
    paths: {
      "/things": {
        get: { operationId: "getList", tags: ["things"] },
        post: {
          operationId: "create",
          tags: ["things"],
          requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Missing" } } } },
        },
      },
    },
  };
  const log: string[] = [];

  const built = buildOperations(broken, (message) => log.push(message));

  // "things" is a tag this server has never seen: off by default, in "other".
  expect(built.map(({ name, toolset }) => ({ name, toolset }))).toEqual([{ name: "things_get_list", toolset: "other" }]);
  expect(log).toEqual(['skipped POST /things: unresolvable $ref "#/components/schemas/Missing"']);
});
