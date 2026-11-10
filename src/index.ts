#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createApi } from "./api.ts";
import { buildOperations } from "./operations.ts";
import { createServer, selectOperations, type ServerOptions } from "./server.ts";
import { loadSpec } from "./spec.ts";

const { AEZA_API_KEY, AEZA_BASE_URL, AEZA_TOOLSETS, AEZA_READ_ONLY, AEZA_MAX_OUTPUT_CHARS } = process.env;

// stdout carries the protocol, so diagnostics go to stderr.
const log = (message: string) => console.error(`aeza-mcp: ${message}`);

try {
  const baseUrl = (AEZA_BASE_URL || "https://my.aeza.ru/api/v2").replace(/\/+$/, "");
  const options: ServerOptions = {
    operations: buildOperations(await loadSpec({ baseUrl, log }), log),
    api: createApi({ baseUrl, apiKey: AEZA_API_KEY || undefined }),
    toolsets: AEZA_TOOLSETS?.split(",")
      .map((name) => name.trim())
      .filter(Boolean),
    readOnly: ["1", "true", "yes"].includes(AEZA_READ_ONLY?.toLowerCase() ?? ""),
    maxOutputChars: Number(AEZA_MAX_OUTPUT_CHARS) || undefined,
  };
  log(`${selectOperations(options.operations, options).length} tools${options.readOnly ? " (read-only)" : ""}`);
  if (!AEZA_API_KEY) log("AEZA_API_KEY is not set, only public endpoints will work");

  serveStdio(() => createServer(options), { onerror: (error) => log(error.message) });
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
