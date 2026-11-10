import type { Schema, Spec, SpecOperation } from "./spec.ts";

export type JsonSchema = Record<string, unknown>;

/** One API operation, described the way an MCP tool needs it. */
export interface Operation {
  /** Tool name: API section and operation id in snake case, e.g. `services_get_list`. */
  name: string;
  toolset: string;
  description: string;
  method: string;
  /** Path template, e.g. `/services/{id}`. */
  path: string;
  /** The operation does not change anything on the account. */
  readOnly: boolean;
  /** Tool arguments: path and query parameters at the top level, the request body under `body`. */
  inputSchema: JsonSchema;
  pathParams: string[];
}

/** Toolset -> API tags. A tag that is not listed lands in `other`, so new API sections stay opt-in. */
const TOOLSETS: Record<string, string[]> = {
  services: [
    "services",
    "services-networks",
    "service-backups",
    "services-ssh-keys",
    "services-resources",
    "services-operating-systems",
    "services-limits",
  ],
  catalog: ["service-products", "service-product-groups", "service-types", "services-orders", "services-static-links"],
  domains: ["domains"],
  billing: [
    "billing-transactions",
    "billing-invoices",
    "billing-payment-methods",
    "account-payment-methods",
    "recurrent-payments",
    "withdraws",
  ],
  account: ["accounts", "api-keys", "sessions", "sso", "companies", "notifications"],
  support: ["support", "support-categories", "support-rates", "support-gpt", "files"],
  promo: ["referral-programs", "gifts", "bonuses", "promo-giftcodes"],
  system: ["system", "other", "leakcheck", "feature-flags"],
  // Plumbing of the web panel: login flows, websocket tokens, web push, consents.
  internal: ["auth", "oauth", "centrifugo", "push-subscriptions", "consents"],
  other: [],
};

export const toolsets = Object.keys(TOOLSETS);
/** `internal` is of no use to an agent, and `other` is whatever appeared upstream since this list was written. */
export const defaultToolsets = toolsets.filter((toolset) => toolset !== "internal" && toolset !== "other");

const toolsetOf = new Map(Object.entries(TOOLSETS).flatMap(([toolset, tags]) => tags.map((tag) => [tag, toolset])));

/** POST operations that only compute or look something up. */
const READ_ONLY_POSTS = new Set([
  "POST /domains/check",
  "POST /domains/check-delegation",
  "POST /services/{id}/additional-resources/get-price",
]);

const METHODS = ["get", "post", "put", "patch", "delete"];

/** JSON Schema keywords that mean the same in OpenAPI 3.0 and are copied as they are. */
const KEYWORDS = [
  "type",
  "enum",
  "format",
  "description",
  "default",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "required",
];

/**
 * Turns the spec into tool definitions. The spec is downloaded at startup with nobody watching,
 * so an operation that cannot be understood is reported and left out instead of failing them all.
 */
export function buildOperations(spec: Spec, log: (message: string) => void = () => {}): Operation[] {
  const schemas = spec.components?.schemas ?? {};
  const operations: Operation[] = [];
  const names = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const source = item[method];
      if (!source) continue;
      try {
        const operation = buildOperation(method.toUpperCase(), path, source, schemas);
        if (names.has(operation.name)) throw new Error(`tool name "${operation.name}" is already taken`);
        names.add(operation.name);
        operations.push(operation);
      } catch (error) {
        log(`skipped ${method.toUpperCase()} ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return operations;
}

function buildOperation(method: string, path: string, source: SpecOperation, schemas: Record<string, Schema>): Operation {
  const route = `${method} ${path}`;
  const tag = source.tags?.[0] ?? "";
  const name = toolName(tag, source.operationId ?? route);
  if (!/^[a-z0-9_]{1,64}$/.test(name)) throw new Error(`"${name}" is not a valid tool name`);

  // Every placeholder is a required argument, declared or not: upstream forgets to declare some
  // (e.g. {recordId}), and a number or a string end up the same in the URL.
  const pathParams = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!);
  const properties: Record<string, JsonSchema> = Object.fromEntries(pathParams.map((param) => [param, { type: ["number", "string"] }]));
  const required = [...pathParams];
  for (const param of source.parameters ?? []) {
    const isPath = param.in === "path" && pathParams.includes(param.name);
    // Headers are left out: the only one upstream declares is a browser's user-agent.
    if (!isPath && param.in !== "query") continue;
    if (param.name === "body" || (!isPath && pathParams.includes(param.name))) {
      throw new Error(`parameter "${param.name}" is ambiguous`);
    }
    properties[param.name] = { ...toJsonSchema(param.schema ?? {}, schemas), ...(param.description && { description: param.description }) };
    if (param.required && !isPath) required.push(param.name);
  }

  if (source.requestBody) {
    const media = source.requestBody.content?.["application/json"];
    if (!media) throw new Error("request body is not JSON");
    // "Send command" bodies are declared as a bare string but carry the command's arguments, so a
    // bare string is read as "any JSON value".
    const untyped = !media.schema || (media.schema.type === "string" && Object.keys(media.schema).length === 1);
    properties.body = untyped ? {} : toJsonSchema(media.schema!, schemas);
    if (source.requestBody.required) required.push("body");
  }

  // A fifth of the operations are undocumented upstream; their name is the best summary there is.
  const summary = [source.summary, source.description].flatMap((text) => (text ? [upperFirst(text.trim())] : []));
  if (!summary.length) summary.push(upperFirst(name.replaceAll("_", " ")));
  if (source.deprecated) summary.push("Deprecated.");

  return {
    name,
    toolset: toolsetOf.get(tag) ?? "other",
    description: [...summary, route].join("\n"),
    method,
    path,
    readOnly: method === "GET" || READ_ONLY_POSTS.has(route),
    inputSchema: { type: "object", properties, ...(required.length && { required }), additionalProperties: false },
    pathParams,
  };
}

const upperFirst = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const singular = (word: string) => word.replace(/s$/, "");
const words = (value: string): string[] =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

/**
 * Operation ids are not unique upstream ("getList" appears 15 times), so the tag goes in front:
 * `("services", "getList")` -> `services_get_list`. Many ids carry a NestJS controller prefix,
 * which is dropped unless it says more than the tag does:
 * `("auth", "AuthTfaController_useTotp")` -> `auth_tfa_use_totp`.
 */
function toolName(tag: string, operationId: string): string {
  const tagWords = words(tag);
  const controller = /^(.+)Controller_(.+)$/.exec(operationId);
  if (!controller) return [...tagWords, ...words(operationId)].join("_");
  const known = new Set(tagWords.map(singular));
  const qualifier = words(controller[1]!).filter((word) => !known.has(singular(word)));
  return [...tagWords, ...qualifier, ...words(controller[2]!)].join("_");
}

/** Converts an OpenAPI 3.0 schema into a self-contained JSON Schema: refs inlined, `nullable` spelled out. */
function toJsonSchema(schema: Schema, schemas: Record<string, Schema>, seen: string[] = []): JsonSchema {
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop()!;
    const target = schemas[name];
    if (!target) throw new Error(`unresolvable $ref "${schema.$ref}"`);
    // A recursive type is cut where it repeats: anything is accepted from there down.
    return seen.includes(name) ? {} : toJsonSchema(target, schemas, [...seen, name]);
  }

  const convert = (child: Schema) => toJsonSchema(child, schemas, seen);
  let result: JsonSchema = {};
  for (const keyword of KEYWORDS) if (schema[keyword] !== undefined) result[keyword] = schema[keyword];
  if (schema.properties) {
    result.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, convert(value)]));
  }
  if (schema.items) result.items = convert(schema.items);
  if (typeof schema.additionalProperties === "object") result.additionalProperties = convert(schema.additionalProperties);
  if (schema.oneOf) result.oneOf = schema.oneOf.map(convert);
  if (schema.anyOf) result.anyOf = schema.anyOf.map(convert);
  if (schema.allOf?.length === 1) {
    // A one-item allOf is how upstream attaches a description to a $ref; a `type` next to it
    // only repeats, sometimes wrongly, what the target says.
    const { type: _, ...own } = result;
    result = { ...convert(schema.allOf[0]!), ...own };
  } else if (schema.allOf) {
    result.allOf = schema.allOf.map(convert);
  }

  if (schema.nullable) {
    if (typeof result.type === "string") {
      result.type = [result.type, "null"];
      if (Array.isArray(result.enum)) result.enum = [...result.enum, null];
    } else if (result.oneOf || result.anyOf || result.allOf) {
      result = { anyOf: [result, { type: "null" }] };
    }
  }
  return result;
}
