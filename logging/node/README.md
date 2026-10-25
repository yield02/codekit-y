# Logging sample — Node.js / TypeScript

This sample implements the codekit logging convention (`conventions/logging.md` in the knowledge store) with [pino](https://github.com/pinojs/pino). AI agents copy it into a project and **rename files, functions and folders to match that project's naming convention**. The code then belongs to the project. There is no dependency on an internal package.

## Files
| File | Purpose |
|---|---|
| `src/logging.ts` | Everything in one file: UUIDv7, AsyncLocalStorage correlation context, the tagged logger wrapper, pretty dev output, HTTP middleware, `fetch`/axios propagation |
| `test/logging.test.ts` | `node:test` checks for fields, mandatory tags, pretty format, and correlation id in/out/propagation |
| `eslint.snippet.json` | Rules that ban `console.*` and direct `pino` imports outside the logging module |

## Setup
```bash
npm i pino            # @opentelemetry/api is optional: when present, its traceId becomes the correlationId
```
```ts
import express from "express";
import { correlationMiddleware, createLogger } from "./logging";

export const log = createLogger({ service: "orders" });
const app = express();
app.use(correlationMiddleware(log));            // first middleware

app.post("/orders", async (req, res) => {
  log.info(["order"], "Order received", { items: req.body.items.length });
  await fetchWithCorrelation("https://payments.internal/charge", { method: "POST" }); // forwards X-Correlation-Id
  res.sendStatus(201);
});
```
- Production: one JSON object per line on stdout.
- Development: set `NODE_ENV=development` or `LOG_PRETTY=1`. Lines then look like this:
  ```
  09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success userId=42 (12ms)
  ```
- Background jobs and queue consumers wrap their work in `withCorrelationId(message.headers["x-correlation-id"], () => handle(message))`.

## Built in: debuggable, not noisy
- `logger` field. Use `log.child("OrderService")` per module so every line says where it came from.
- One `info` line per request (`Request finished`, with `durationMs`). It becomes `warn` `Slow request` above `slowMs` (default 1000). `Request started` is `debug`. Disable the framework's access log.
- `context` is sanitized:
  - keys like `password`, `token`, `authorization`, `cookie`, `apiKey` and `card` become `[redacted]`
  - strings over 500 characters, arrays over 20 items, nesting deeper than 3 levels and more than 20 keys are truncated
- Errors keep the `cause` chain in `error.stack`.
- The same error from the same logger is written once per 60 s. The next write carries `context.repeated`.
- `debug` is off unless `LOG_LEVEL=debug`.
- `codekit logs --stats` on a log file shows the noisiest messages.

## Tests
```bash
node --test test/logging.test.ts     # Node 22.6+ (type stripping), after npm i pino
```
