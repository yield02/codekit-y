#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLogger } from "../core/logger.js";
import { createServer, VERSION } from "./server.js";

const log = createLogger("codemap-mcp");

async function main(): Promise<void> {
  if (process.argv.includes("--version")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  const server = createServer();
  await server.connect(new StdioServerTransport());
  log.info(["mcp", "lifecycle"], "codemap-mcp started", { version: VERSION, cwd: process.cwd() });
}

main().catch((err) => {
  log.error(["mcp", "lifecycle"], "codemap-mcp crashed", err);
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
