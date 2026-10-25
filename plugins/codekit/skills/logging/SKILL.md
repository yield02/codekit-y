---
name: logging
description: Write logs that follow the project's logging convention (mandatory correlationId and registry tags). Use whenever adding or changing logging, request handling, external calls or error handling.
---

# logging

1. Call `logging_convention` to get the required fields, the correlationId rules and the tag registry.
2. Use the project's logger wrapper: `log.info(tags, message, context?)` and `log.error(tags, message, error, context?)`. Never use `console.log`, `System.out`, `print` or a raw logger.
3. Use only tags from the registry. If no tag fits, propose one to the user and register it with `logging_add_tag` once they agree.
4. Make sure every entry point (HTTP, queue consumer, job) sets the correlationId (read `X-Correlation-Id` / OpenTelemetry traceId, or generate a UUIDv7), returns it in the response header, and propagates it on outgoing calls.
5. If the project has no wrapper yet, generate one into the source following the project's naming convention. Keep it small: a logger plus request-scoped context plus middleware.
6. Log at boundaries (request in/out with `durationMs`, external calls, retries, errors). Never log secrets, tokens or full personal data.
