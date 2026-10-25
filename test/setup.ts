import { afterEach } from "vitest";

// Most tests are synchronous chains of git commands. Between synchronous tests vitest only
// yields microtasks, so the worker never reaches the I/O phase where its RPC replies arrive:
// blocking time adds up over a whole file, and past 60 s vitest reports
// `Timeout calling "onTaskUpdate"` (seen on slow CI runners). One macrotask per test keeps
// each blocking stretch to a single test.
afterEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
