# Logging sample: ASP.NET Core (.NET 8) + Serilog

Reference implementation of the codekit logging convention for ASP.NET Core minimal APIs and controllers.

> **For AI agents:** copy `src/Logging/` into the target project and rename the namespace (`Codekit.Logging`),
> classes and files to match the project's naming convention (for example `Acme.Orders.Infrastructure.Logging`).
> Keep the behavior and the output field names exactly as they are. Use only tags from the project's tag registry.

## Convention in short

Every entry has `timestamp` (ISO-8601 UTC), `level`, `service`, `correlationId`, `tags` (at least one) and `message`,
and optionally `context`, `durationMs` and `error` {type, message, stack}.

## Files

| File | Purpose |
| --- | --- |
| `src/Logging/CorrelationId.cs` | Header name constant, id resolution (`X-Correlation-Id` header, then `Activity.Current` TraceId, then UUIDv7), AsyncLocal `Current`, `BeginScope()` for any entry point. |
| `src/Logging/TaggedLogger.cs` | The wrapper: `Info/Debug/Warn(tags, message, context?, durationMs?)` and `Error(tags, message, exception, context?, durationMs?)`. Empty or blank tags throw `ArgumentException`. |
| `src/Logging/CorrelationIdMiddleware.cs` | Scopes the id per request (AsyncLocal, Serilog `LogContext`, `HttpContext.Items`), sets the response header, logs `http` request in/out with method, path, status and `durationMs`. `app.UseCorrelationId()`, `HttpContext.GetCorrelationId()`. |
| `src/Logging/CorrelationIdHandler.cs` | `DelegatingHandler` that adds `X-Correlation-Id` to outgoing calls, plus `IHttpClientBuilder.AddCorrelationIdPropagation()`. |
| `src/Logging/JsonLogFormatter.cs` | Production `ITextFormatter`: one JSON object per line with the convention's field names. |
| `src/Logging/PrettyLogFormatter.cs` | Development `ITextFormatter`: one readable line per entry. |
| `src/Logging/LogFields.cs` | Shared property names and read helpers (internal). |
| `src/Logging/LoggingSetup.cs` | `builder.Host.UseCodekitLogging()`: Serilog, console sink, formatter chosen by environment, `service` = `IHostEnvironment.ApplicationName`. |
| `Program.snippet.cs` | Wiring example with two endpoints. |
| `packages.snippet.xml` | `PackageReference` lines and the analyzer setup to merge into the `.csproj`. |
| `BannedSymbols.txt` | Bans `Console.WriteLine` and the static `Serilog.Log.Debug/Information/Warning/Error` methods. |

## Setup

1. Merge `packages.snippet.xml` into the web project's `.csproj` (Serilog 4.x, Serilog.AspNetCore 8.x,
   Serilog.Sinks.Console, Microsoft.CodeAnalysis.BannedApiAnalyzers). If `src/Logging/` goes into a class library
   instead of the web project, that library also needs `<FrameworkReference Include="Microsoft.AspNetCore.App" />`.
2. Copy `src/Logging/` into the project and rename the namespace (see the note above).
3. Copy `BannedSymbols.txt` next to the `.csproj` (it is referenced as an `AdditionalFiles` item).
4. Wire `Program.cs` as in `Program.snippet.cs`:

```csharp
builder.Host.UseCodekitLogging();
builder.Services.AddHttpClient("rates").AddCorrelationIdPropagation();

var app = builder.Build();
app.UseCorrelationId(); // register first
```

## Usage

```csharp
private static readonly TaggedLogger Log = TaggedLogger.For<LoginService>();

Log.Info(["auth", "login"], "Login success", new { userId = 42 }, durationMs: 12);
Log.Warn(["auth", "login"], "Login rejected", new { reason = "invalid_credentials" });
Log.Error(["payment", "external"], "Charge failed", ex, new Dictionary<string, object?> { ["orderId"] = orderId });
```

`context` takes an anonymous object or an `IReadOnlyDictionary<string, object?>`. The message is always logged as
plain text (never parsed as a Serilog template), so it is safe to build with string interpolation, but put variable
data in `context` instead so it stays queryable. Never log secrets, tokens or full personal data.

Development output:

```text
09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success userId=42 (12ms)
```

Production output (one line, shown wrapped here):

```json
{"timestamp":"2026-10-25T09:12:03.120Z","level":"info","service":"Acme.Api",
 "correlationId":"0192b6a4-7c1e-7d2a-9f10-5be47f3a91c2","tags":["auth","login"],
 "message":"Login success","context":{"userId":42},"durationMs":12}
```

## Correlation id

- HTTP: `CorrelationIdMiddleware` reads `X-Correlation-Id` (accepted only if 1-128 chars of `[A-Za-z0-9._-]`),
  else uses `Activity.Current.TraceId` (OpenTelemetry/W3C), else generates a UUIDv7. The id is pushed to Serilog's
  `LogContext`, stored in `HttpContext.Items["correlationId"]` and returned in the `X-Correlation-Id` response header.
  ASP.NET Core usually starts an `Activity` per request, so without an incoming header the id is normally the trace id.
- Queue consumers, background jobs: wrap each message or run in a scope.

```csharp
using var _ = CorrelationId.BeginScope(message.Headers.GetValueOrDefault("X-Correlation-Id"));
```

- Outgoing HTTP: add `.AddCorrelationIdPropagation()` to every `AddHttpClient(...)` registration.

## Notes

- Entries that do not come through `TaggedLogger` (ASP.NET Core, EF Core, libraries) get the tag `framework` and
  their template properties as `context`. Add `framework` to the tag registry or change `LogFields.FallbackTag`.
- Entries outside any correlation scope (startup, shutdown) get `correlationId: "none"`.
- Levels are written as `debug`, `info`, `warn`, `error` (Serilog `Verbose` maps to `debug`, `Fatal` to `error`).
- `error.stack` is `Exception.ToString()`, so inner exceptions are included.
- `BannedSymbols.txt` uses documentation-comment ids (`M:...`), one per overload. `Serilog.Log.Logger.Information(...)`
  and `Microsoft.Extensions.Logging.ILogger.LogInformation(...)` are not covered; add their ids if the project wants
  those banned too.
- `Serilog.Formatting.Compact` is not needed: `JsonLogFormatter` replaces `CompactJsonFormatter` so the field names match
  the convention instead of `@t`, `@l`, `@m`.
