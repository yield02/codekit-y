---
name: logging
description: Write logs that follow the project's logging convention (mandatory correlationId and registry tags) without over-logging, reusing the project's existing logger. Use whenever adding or changing logging, request handling, external calls or error handling.
---

# logging

## 1. Know the project's logger first
1. Call `logging_convention`. If its **Project logger** table names an entry point, use that logger and nothing else, then continue with step 2.
2. Otherwise call `logging_detect` (a read-only scan) and follow the strategy it returns:
   - **in-house**: the project has its own logger (for example `LogHelper` or `utils/logger`). Extend that one by following `logging_sample` with `library: "in-house"`. Add the tags parameter so old calls keep working with tag `legacy`, read the correlationId from context, and change the output format.
   - **library**: the project already uses a library (log4j2, NLog, winston, loguru…). Keep it. Call `logging_sample` with the stack and library, configure that library's formatter and context, and add a thin tagged wrapper.
   - **reference-sample**: the project has nothing. Adapt `logging_sample` for the stack into the source, using the project's naming convention.

   **Never add a second logging library or a parallel logger.**
3. After adopting the convention, record the entry point with `logging_set_project`.

## 2. Writing log calls
- Use the wrapper's API: `log.info(tags, message, context?)` and `log.error(tags, message, error, context?)`. Never use `console.log`, `System.out`, `print` or a raw logger.
- Use tags from the registry only. If none fits, propose one to the user and add it with `logging_add_tag` once they agree.
- Keep the `message` text stable and put the data in `context`: business ids (`orderId`, `userId`), counts, status. Do not put payloads in context.
- Every entry point (HTTP, consumer, job) sets the correlationId, returns it in the response header, and propagates it on outgoing calls. Reuse the middleware from the sample.

## 3. Log what helps debugging, nothing more
Log these:
- one `info` line per request or job, with `durationMs`
- external call results
- state changes, with the entity id
- retries and fallbacks as `warn`, with the attempt number
- slow operations as `warn`
- a failure **once, where it is handled**, as an `error` with the error object and the ids needed to reproduce it

Do not log these:
- anything inside loops (log one summary instead)
- "entering/leaving" lines
- log-and-rethrow
- full request/response bodies
- secrets
- a line the framework already writes
- `debug` level in production by default

## 4. Self-check before finishing
For each code path you changed, count the lines it writes:
- A healthy request should produce **1–3 info lines**.
- A failing request should add **exactly one error line**, and that line should explain the failure without needing any other line.

If you wrote more than that, remove lines. If you have the logs of a run, `codekit logs --stats` shows the noisiest messages and gives hints.
