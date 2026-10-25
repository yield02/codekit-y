# Adopting the convention in a project's own logger

Use this when the project already has its own logging code that the rest of the code imports, for example `LogHelper`, `utils/logger.ts`, `AppLogger`, `common/log.py` or `ILogService`. Use it also for a library that has no dedicated guide (log4js, log4net, the NestJS `LoggerService`…).

`logging_detect` lists the candidates and how often each is used. The one with the most usages is the entry point.

**Rule: that logger stays the single entry point.** Never add a second logger next to it. Never rewrite every call site in one go.

## 1. Make it tag-aware without breaking callers
Add the convention's signature next to the existing one. Old calls keep working and log with tag `legacy`.

```ts
// TypeScript: overload by the first argument
info(tagsOrMessage: string[] | string, messageOrArg?: unknown, context?: Record<string, unknown>) {
  if (Array.isArray(tagsOrMessage)) return this.write("info", tagsOrMessage, String(messageOrArg), context);
  return this.write("info", ["legacy"], String(tagsOrMessage), messageOrArg === undefined ? undefined : { args: messageOrArg });
}
```
```java
// Java: add overloads, keep the old ones delegating
public void info(List<String> tags, String message, Map<String, ?> context) { write(INFO, tags, message, context, null); }
public void info(String message, Object... args) { write(INFO, List.of("legacy"), format(message, args), null, null); }
```
```csharp
// C#: same idea with overloads
public void Info(IReadOnlyList<string> tags, string message, object? context = null) => Write(Info, tags, message, context);
public void Info(string message) => Write(Info, ["legacy"], message, null);
```
```python
# Python: tags first when it is a list
def info(self, tags_or_message, message=None, context=None):
    if isinstance(tags_or_message, (list, tuple)):
        return self._write("info", list(tags_or_message), message, context)
    return self._write("info", ["legacy"], tags_or_message, {"args": message} if message is not None else None)
```
New code, and any code the AI touches, uses the tagged form.

## 2. Put correlationId inside the logger
The logger reads the id from request-scoped context itself, so callers never pass it:
- Node: AsyncLocalStorage (`currentCorrelationId()` in `logging/node/src/logging.ts`)
- Java: MDC (`CorrelationId` in `logging/java`)
- .NET: AsyncLocal (`CorrelationId.Current` in `logging/dotnet`)
- Python: ContextVar (`current_correlation_id()` in `logging/python/codekit_logging.py`)

Copy the **entry-point middleware/filter** and the **outgoing propagation** from the reference sample for the stack. They do not depend on the logger. Wire them in once.

## 3. Change the output, not the callers
- If the logger prints to the console itself (`console.log`, `System.out`, `Console.WriteLine`, `print`), replace that one sink with the convention's JSON line in production and the pretty line in development. Reuse `formatPretty` / `PrettyLogLayout` / `PrettyLogFormatter` / `format_pretty` from the sample.
- If the logger wraps a library (log4j2, NLog, winston…), configure that library's layout/formatter (see its guide in this folder) and pass `tags`, `context` and `durationMs` as structured properties.
- Fill `logger` with the caller's module/class name. Add a factory such as `Logger.for("OrderService")` if the in-house logger has no notion of names, and keep a default name for old calls.

## 4. Build the debugging and anti-noise rules into the logger
These belong in the single entry point, so no caller can forget them:
- **Redact** context keys matching `password|passwd|secret|token|authorization|cookie|apikey|api_key|card` and replace the value with `"[redacted]"`.
- **Bound the size:** strings over 500 chars are truncated with `…(+N)`, arrays show their first 20 items plus a count, and nesting stops at depth 3. Large payloads never reach the log.
- **Shape errors:** always write `error.type`, `error.message` and `error.stack` including causes. Never write only `String(err)`.
- **Collapse repeats:** the same `error` message from the same `logger` within 60 s is written once. The next write adds `context.repeated = N`.
- **Gate levels:** `debug` is off unless `LOG_LEVEL=debug` (or a per-logger override) is set.

## 5. Record it and keep it the only way
1. Call `logging_set_project` with `library` (for example `in-house over winston`), `entryPoint` (the module path) and short `notes`. Every agent then uses the same logger.
2. Ban raw logging outside the logger module with the lint snippet of the stack (`eslint.snippet.json`, ArchUnit test, `BannedSymbols.txt`, `ruff.snippet.toml`). Point the allowed path at the in-house module.
3. Migrate gradually. `codekit logs --stats` shows which `legacy` messages are the noisiest, so those are the first ones worth converting or deleting.

## Checklist
- [ ] Old calls compile and still log, with tag `legacy`.
- [ ] `curl -H "X-Correlation-Id: test-12345678" …` and every line of that request has `correlationId: test-12345678`. The response carries the header back.
- [ ] A request without the header gets a generated id, and downstream services receive it.
- [ ] Production output is one JSON object per line with the convention's field names. Dev output is the pretty line.
- [ ] Secrets in context are `[redacted]`, and a 10 kB string is truncated.
- [ ] One failing request produces exactly one `error` line, with the stack.
- [ ] A healthy request produces 1–3 `info` lines.
