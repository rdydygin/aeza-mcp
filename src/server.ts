import { readFileSync } from "node:fs";
import { type CallToolResult, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { AezaError, type Api } from "./api.ts";
import { defaultToolsets, type Operation, toolsets } from "./operations.ts";

export interface ServerOptions {
  operations: Operation[];
  api: Api;
  /** Toolsets to expose; `"all"` selects every one. Default: all but `internal` and `other`. */
  toolsets?: string[];
  /** Expose only tools that do not change anything on the account. */
  readOnly?: boolean;
  /** Expose tools that delete something (HTTP DELETE): services, domains, backups, API keys, the account itself. Off by default. */
  allowDelete?: boolean;
  /** Longer tool results are truncated, so one big list cannot flood the model's context. Default: 40 000. */
  maxOutputChars?: number;
}

const INSTRUCTIONS = `Tools mirror the Aeza hosting REST API (my.aeza.ru/api/v2), one tool per endpoint, named <section>_<action>.
Most list tools take offset and limit; some lists are large, so filter where the tool allows it.
Tools that are not read-only act on the real account: ordering, prolonging and buying spend its balance; deleting or reinstalling a service destroys its data. Confirm such actions with the user first.`;

const NO_DELETE = `
Tools that delete something are not available: the user has not enabled them. To delete a service, domain, backup or anything else, the user can do it in the Aeza panel or restart this server with AEZA_ALLOW_DELETE=1.`;

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export function selectOperations(
  operations: Operation[],
  options: Pick<ServerOptions, "toolsets" | "readOnly" | "allowDelete"> = {},
): Operation[] {
  const requested = options.toolsets ?? defaultToolsets;
  const unknown = requested.filter((name) => name !== "all" && !toolsets.includes(name));
  if (unknown.length) throw new Error(`Unknown toolset: ${unknown.join(", ")}. Available: all, ${toolsets.join(", ")}`);
  const enabled = new Set(requested.includes("all") ? toolsets : requested);
  return operations.filter(
    (operation) =>
      enabled.has(operation.toolset) &&
      (!options.readOnly || operation.readOnly) &&
      (options.allowDelete || operation.method !== "DELETE"),
  );
}

export function createServer(options: ServerOptions): McpServer {
  const maxOutputChars = options.maxOutputChars ?? 40_000;
  const server = new McpServer({ name: "aeza", version }, { instructions: INSTRUCTIONS + (options.allowDelete || options.readOnly ? "" : NO_DELETE) });

  for (const operation of selectOperations(options.operations, options)) {
    server.registerTool(
      operation.name,
      {
        description: operation.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(operation.inputSchema),
        annotations: {
          readOnlyHint: operation.readOnly,
          // Any mutation may be irreversible here: orders spend money, a reinstall wipes the disk.
          destructiveHint: !operation.readOnly,
          idempotentHint: operation.readOnly || operation.method === "PUT" || operation.method === "DELETE",
          openWorldHint: true,
        },
      },
      async ({ body, ...params }): Promise<CallToolResult> => {
        const isPath = ([name]: [string, unknown]) => operation.pathParams.includes(name);
        const pathParams = Object.fromEntries(Object.entries(params).filter(isPath));
        const query = { ...operation.queryDefaults, ...Object.fromEntries(Object.entries(params).filter((entry) => !isPath(entry))) };
        try {
          const data = await options.api({ method: operation.method, path: operation.path, pathParams, query, body });
          return { content: [{ type: "text", text: render(data, maxOutputChars) }] };
        } catch (error) {
          return { content: [{ type: "text", text: describeError(error) }], isError: true };
        }
      },
    );
  }
  return server;
}

function render(data: unknown, limit: number): string {
  // Most actions answer with no body at all; say so instead of handing the model a bare "null".
  if (data === undefined) return "OK (the API returned an empty response)";
  const text = typeof data === "string" ? data : JSON.stringify(data);
  if (text.length <= limit) return text;

  // A list is cut at an item boundary, so the result stays valid JSON.
  const envelope = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const items = Array.isArray(data) ? data : envelope.items;
  if (Array.isArray(items)) {
    let size = 0;
    let count = 0;
    for (const item of items) {
      size += JSON.stringify(item).length + 1;
      if (size > limit) break;
      count++;
    }
    const truncated = `Showing ${count} of ${items.length} items: the full result exceeds ${limit} characters. Narrow the request with the tool's parameters (offset, limit, filter, ...).`;
    return JSON.stringify({ ...envelope, items: items.slice(0, count), truncated });
  }
  return `${text.slice(0, limit)}\n[Truncated: ${text.length - limit} more characters]`;
}

function describeError(error: unknown): string {
  if (!(error instanceof AezaError)) return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // The payload often just repeats the message; show it only when it adds something.
  const payload = typeof error.payload === "string" ? error.payload : (JSON.stringify(error.payload) ?? "");
  const details = payload && !error.message.includes(payload) ? `\n${payload}` : "";
  const hint = error.status === 401 ? "\nSet AEZA_API_KEY to a valid Aeza API key." : "";
  return `Aeza API error ${error.message}${details}${hint}`;
}
