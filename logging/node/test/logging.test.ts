// Run: node --test test/logging.test.ts   (Node 22.6+ with type stripping, after `npm i pino`)
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Writable } from "node:stream";
import { test } from "node:test";
import { correlationMiddleware, createLogger, currentCorrelationId, fetchWithCorrelation, formatPretty, uuidv7, withCorrelationId } from "../src/logging.ts";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({ write(c, _e, done) { lines.push(...c.toString().split("\n").filter(Boolean)); done(); } });
  return { lines, stream };
}

test("JSON entries carry the required fields", async () => {
  const { lines, stream } = capture();
  const log = createLogger({ service: "orders", destination: stream, pretty: false });
  withCorrelationId("abc-123-correlation", () => log.info(["auth", "login"], "Login success", { userId: 42, durationMs: 12 }));
  await new Promise((r) => setImmediate(r));
  const entry = JSON.parse(lines[0]!);
  assert.equal(entry.service, "orders");
  assert.equal(entry.correlationId, "abc-123-correlation");
  assert.deepEqual(entry.tags, ["auth", "login"]);
  assert.equal(entry.message, "Login success");
  assert.deepEqual(entry.context, { userId: 42 });
  assert.equal(entry.durationMs, 12);
  assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(entry.level, "info");
});

test("logger field names the module; child() switches it", async () => {
  const { lines, stream } = capture();
  const log = createLogger({ service: "orders", logger: "OrderService", destination: stream, pretty: false });
  log.info(["order"], "Order placed", { orderId: "o-1" });
  log.child("PaymentClient").info(["payment"], "Charge accepted");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(lines.map((l) => JSON.parse(l).logger), ["OrderService", "PaymentClient"]);
});

test("context is redacted and size-bounded; errors keep their cause chain", async () => {
  const { lines, stream } = capture();
  const log = createLogger({ service: "s", destination: stream, pretty: false });
  const cause = new Error("connection refused");
  log.error(["db"], "Query failed", new Error("could not load order", { cause }), {
    password: "hunter2", authToken: "abc", note: "x".repeat(2000), ids: Array.from({ length: 50 }, (_, i) => i), deep: { a: { b: { c: { d: 1 } } } },
  });
  await new Promise((r) => setImmediate(r));
  const e = JSON.parse(lines[0]!);
  assert.equal(e.context.password, "[redacted]");
  assert.equal(e.context.authToken, "[redacted]");
  assert.ok(e.context.note.length < 600 && e.context.note.includes("…(+1500)"));
  assert.equal(e.context.ids.length, 21);
  assert.equal(e.context.deep.a.b, "[object]");
  assert.match(e.error.stack, /Caused by: Error: connection refused/);
});

test("the same error is written once per minute, then with a repeat count", async () => {
  const { lines, stream } = capture();
  const log = createLogger({ service: "s", destination: stream, pretty: false });
  for (let i = 0; i < 50; i++) log.error(["external-api"], "Rates API down", new Error("503"));
  await new Promise((r) => setImmediate(r));
  assert.equal(lines.length, 1);
});

test("debug is off by default", async () => {
  const { lines, stream } = capture();
  createLogger({ service: "s", destination: stream, pretty: false }).debug(["job"], "noise");
  await new Promise((r) => setImmediate(r));
  assert.equal(lines.length, 0);
});

test("tags are mandatory", () => {
  const log = createLogger({ service: "s", destination: capture().stream, pretty: false });
  assert.throws(() => log.info([], "no tags"), /tag/);
});

test("pretty format matches the convention", () => {
  const line = formatPretty({ timestamp: "2026-10-25T09:12:03.120Z", level: "info", correlationId: "0190aaaa-7f3a91c2", tags: ["auth", "login"], message: "Login success", context: { userId: 42 }, durationMs: 12 });
  assert.equal(line, "09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success userId=42 (12ms)");
});

test("uuidv7 is time-ordered and well-formed", () => {
  const a = uuidv7(1_700_000_000_000), b = uuidv7(1_700_000_000_001);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(a < b);
});

test("middleware reuses or creates the id, returns it, and propagates it downstream", async () => {
  const { lines, stream } = capture();
  const log = createLogger({ service: "gw", destination: stream, pretty: false });
  let downstreamSaw: string | undefined;
  const downstream = createServer((req, res) => { downstreamSaw = req.headers["x-correlation-id"] as string; res.end("ok"); });
  await new Promise<void>((r) => downstream.listen(0, r));
  const downPort = (downstream.address() as { port: number }).port;

  const mw = correlationMiddleware(log);
  const server = createServer((req, res) => mw(req as never, res, async () => {
    await fetchWithCorrelation(`http://127.0.0.1:${downPort}/`);
    res.end(currentCorrelationId());
  }));
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;

  const given = await fetch(`http://127.0.0.1:${port}/x`, { headers: { "X-Correlation-Id": "given-id-12345" } });
  assert.equal(given.headers.get("x-correlation-id"), "given-id-12345");
  assert.equal(await given.text(), "given-id-12345");
  assert.equal(downstreamSaw, "given-id-12345");

  const fresh = await fetch(`http://127.0.0.1:${port}/y`);
  assert.match(fresh.headers.get("x-correlation-id")!, /^[0-9a-f-]{36}$/);

  await new Promise((r) => setTimeout(r, 20));
  const finished = lines.map((l) => JSON.parse(l)).filter((e) => e.message === "Request finished");
  assert.equal(finished.length, 2);
  assert.ok(finished.every((e) => e.tags[0] === "http" && typeof e.durationMs === "number" && e.context.status === 200));
  server.close(); downstream.close();
});
