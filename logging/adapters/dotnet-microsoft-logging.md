# Adopting the convention with plain Microsoft.Extensions.Logging (.NET 8)

This guide is for projects that log through `ILogger<T>` with only the built-in console provider. Reuse these from `logging/dotnet/src/Logging/`: `CorrelationId.cs`, `CorrelationIdMiddleware.cs`, `CorrelationIdHandler.cs`, plus `ValidateTags`/`ToDictionary` from `TaggedLogger.cs`. Don't copy the Serilog files (`JsonLogFormatter.cs`, `PrettyLogFormatter.cs`, `LogFields.cs`, `LoggingSetup.cs`), and don't add Serilog or NLog. MEL and its console provider stay the only logging stack.

## 1. When this applies
- **Packages:** no `Serilog*`, `NLog*` or `log4net` in any `.csproj`. ASP.NET Core gets `Microsoft.Extensions.Logging(.Console)` from the shared framework; worker and console apps reference it explicitly.
- **Code:** `ILogger<T>` constructor injection, `_logger.LogInformation(...)`, `builder.Logging.AddJsonConsole()` / `AddSimpleConsole()` / `AddConsole()`, `LoggerMessage.Define`, `[LoggerMessage]`.
- **Config:** a `"Logging"` section in `appsettings*.json`, often with `"Console": { "FormatterName": "json" }`. The built-in `JsonConsoleFormatter` writes `Timestamp/EventId/LogLevel/Category/Message/State/Scopes` and can't rename them, so a custom `ConsoleFormatter` replaces it.

## 2. correlationId: ILogger.BeginScope and IExternalScopeProvider
- `CorrelationId.cs`: delete `using Serilog.Context;` and the `LogContext.PushProperty(...)` call. `BeginScope` now only sets the AsyncLocal, and `Scope` only restores `previous`. Resolution and `Current` stay as they are.
- `CorrelationIdMiddleware.cs`: inject the logger and open a MEL scope, so every provider sees the id. The formatters read it through `IExternalScopeProvider`, falling back to `CorrelationId.Current`. Delete the static `Log` field and use the extensions from section 5:
```csharp
public async Task InvokeAsync(HttpContext context, ILogger<CorrelationIdMiddleware> logger)
{
    // ... id resolution, Items, OnStarting header: unchanged
    using var scope = CorrelationId.BeginScope(id);
    using var logScope = logger.BeginScope(new Dictionary<string, object> { [CorrelationId.PropertyName] = id });
    logger.Info(HttpTags, "Request started", new { method, path });   // was Log.Info(...); same for Error / "Request finished"
```
- `CorrelationIdHandler.cs`: no changes. Register it with `AddHttpClient(...).AddCorrelationIdPropagation()`, and keep `app.UseCorrelationId()` as the first middleware.
- Jobs and consumers: `using var a = CorrelationId.BeginScope(header); using var b = logger.BeginScope(new Dictionary<string, object> { ["correlationId"] = CorrelationId.Current! });`.

## 3. JSON output: a custom ConsoleFormatter (`CodekitFormatters.cs`)
```csharp
using System.Buffers; using System.Globalization; using System.Text; using System.Text.Encodings.Web; using System.Text.Json;
using Microsoft.Extensions.Logging; using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Logging.Console; using Microsoft.Extensions.Options;

public sealed class CodekitFormatterOptions : ConsoleFormatterOptions { public string Service { get; set; } = "unknown"; }

internal static class LogShape
{
    public static string Level(LogLevel l) => l switch
        { LogLevel.Trace or LogLevel.Debug => "debug", LogLevel.Information => "info", LogLevel.Warning => "warn", _ => "error" };

    public static string CorrelationIdOf(IExternalScopeProvider? scopes)
    {
        string? found = null;                                     // scopes are visited outer to inner: innermost wins
        scopes?.ForEachScope((scope, _) =>
        {
            if (scope is IEnumerable<KeyValuePair<string, object?>> kvs)
                foreach (var kv in kvs) if (kv.Key == CorrelationId.PropertyName && kv.Value is string s) found = s;
        }, (object?)null);
        return found ?? CorrelationId.Current ?? CorrelationId.None;
    }

    public static string[] Tags(TaggedState? t) => t?.Tags ?? ["legacy"];

    /// Tagged entry: its context. Legacy LogXxx("... {OrderId}", id): the template values become the context.
    public static IReadOnlyDictionary<string, object?>? Context<TState>(TState state)
    {
        if (state is TaggedState t) return t.Context;
        if (state is not IReadOnlyList<KeyValuePair<string, object?>> kvs) return null;
        var d = new Dictionary<string, object?>();
        foreach (var kv in kvs) if (kv.Key != "{OriginalFormat}") d[kv.Key] = kv.Value;
        return d;
    }
}

public sealed class CodekitJsonFormatter(IOptionsMonitor<CodekitFormatterOptions> options) : ConsoleFormatter("codekit-json")
{
    private static readonly JsonWriterOptions WriterOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public override void Write<TState>(in LogEntry<TState> entry, IExternalScopeProvider? scopeProvider, TextWriter textWriter)
    {
        var tagged = entry.State as TaggedState;
        var buffer = new ArrayBufferWriter<byte>(512);
        using (var w = new Utf8JsonWriter(buffer, WriterOptions))
        {
            w.WriteStartObject();
            w.WriteString("timestamp", DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture));
            w.WriteString("level", LogShape.Level(entry.LogLevel));
            w.WriteString("service", options.CurrentValue.Service);
            w.WriteString("logger", entry.Category);
            w.WriteString("correlationId", LogShape.CorrelationIdOf(scopeProvider));
            w.WriteStartArray("tags"); foreach (var tag in LogShape.Tags(tagged)) w.WriteStringValue(tag); w.WriteEndArray();
            w.WriteString("message", tagged?.Message ?? entry.Formatter(entry.State, entry.Exception));
            if (LogShape.Context(entry.State) is { Count: > 0 } ctx) { w.WritePropertyName("context"); JsonSerializer.Serialize(w, ctx); }
            if (tagged?.DurationMs is { } ms) w.WriteNumber("durationMs", ms);
            if (entry.Exception is { } ex)
            {
                w.WriteStartObject("error"); w.WriteString("type", ex.GetType().FullName); w.WriteString("message", ex.Message);
                w.WriteString("stack", ex.ToString()); w.WriteEndObject();           // ToString() includes inner exceptions
            }
            w.WriteEndObject();
        }
        textWriter.WriteLine(Encoding.UTF8.GetString(buffer.WrittenSpan));
    }
}
```
In `Program.cs`, this replaces any existing `AddJsonConsole()`/`AddSimpleConsole()` call. Also remove `Logging:Console:FormatterName` from `appsettings*.json`. Keep `Logging:LogLevel` as it is (for example `"Microsoft.AspNetCore": "Warning"`). Context values must be JSON-serializable, so no cycles.
```csharp
builder.Logging
    .AddConsole(o => o.FormatterName = builder.Environment.IsDevelopment() ? "codekit-pretty" : "codekit-json")
    .AddConsoleFormatter<CodekitJsonFormatter, CodekitFormatterOptions>(o => o.Service = builder.Environment.ApplicationName)
    .AddConsoleFormatter<CodekitPrettyFormatter, ConsoleFormatterOptions>();
```

## 4. Dev pretty output (same file)
```csharp
public sealed class CodekitPrettyFormatter() : ConsoleFormatter("codekit-pretty")
{
    public override void Write<TState>(in LogEntry<TState> entry, IExternalScopeProvider? scopeProvider, TextWriter textWriter)
    {
        var tagged = entry.State as TaggedState;
        var cid = LogShape.CorrelationIdOf(scopeProvider);
        var sb = new StringBuilder()
            .Append(DateTime.Now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture)).Append(' ')
            .Append(LogShape.Level(entry.LogLevel).ToUpperInvariant().PadRight(5))
            .Append(" [cid=").Append(cid.Length > 8 ? cid[^8..] : cid).Append("] [")
            .Append(string.Join(',', LogShape.Tags(tagged))).Append("] ")
            .Append(tagged?.Message ?? entry.Formatter(entry.State, entry.Exception));
        foreach (var (k, v) in LogShape.Context(entry.State) ?? new Dictionary<string, object?>())
            sb.Append(' ').Append(k).Append('=').Append(Convert.ToString(v, CultureInfo.InvariantCulture));
        if (tagged?.DurationMs is { } ms) sb.Append(" (").Append(ms.ToString("0", CultureInfo.InvariantCulture)).Append("ms)");
        if (entry.Exception is { } ex) sb.Append(" error=").Append(ex.GetType().FullName).Append(": ").Append(ex.Message).AppendLine().Append(ex);
        textWriter.WriteLine(sb.ToString());   // 09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success userId=42 (12ms)
    }
}
```

## 5. Tagged wrapper: extension methods on `ILogger` (`TaggedLogger.cs`)
Existing classes keep their injected `ILogger<T>`, so there are no DI changes. Copy `ValidateTags` and `ToDictionary` verbatim from the sample's `TaggedLogger.cs`.
```csharp
using System.Collections;
using Microsoft.Extensions.Logging;

public static class TaggedLogger
{
    public static void Debug(this ILogger logger, IReadOnlyList<string> tags, string message, object? context = null, double? durationMs = null) => Write(logger, LogLevel.Debug, tags, message, null, context, durationMs);
    public static void Info(this ILogger logger, IReadOnlyList<string> tags, string message, object? context = null, double? durationMs = null) => Write(logger, LogLevel.Information, tags, message, null, context, durationMs);
    public static void Warn(this ILogger logger, IReadOnlyList<string> tags, string message, object? context = null, double? durationMs = null) => Write(logger, LogLevel.Warning, tags, message, null, context, durationMs);
    public static void Error(this ILogger logger, IReadOnlyList<string> tags, string message, Exception? exception, object? context = null, double? durationMs = null) => Write(logger, LogLevel.Error, tags, message, exception, context, durationMs);

    private static void Write(ILogger logger, LogLevel level, IReadOnlyList<string> tags, string message, Exception? exception, object? context, double? durationMs)
    {
        ValidateTags(tags);                                    // throws even when the level is disabled
        ArgumentNullException.ThrowIfNull(message);
        if (!logger.IsEnabled(level)) return;
        var state = new TaggedState(message, tags.ToArray(), ToDictionary(context), durationMs is { } ms ? Math.Round(ms, 2) : null);
        logger.Log(level, default, state, exception, static (s, _) => s.Message);   // literal message, no template parsing
    }
    // ValidateTags(...) and ToDictionary(...) copied from the sample
}

/// The state is a list of key/value pairs, so other providers (OpenTelemetry, NLog via MEL) also get tags/context/durationMs.
public sealed class TaggedState(string message, string[] tags, IReadOnlyDictionary<string, object?>? context, double? durationMs)
    : IReadOnlyList<KeyValuePair<string, object?>>
{
    private readonly KeyValuePair<string, object?>[] _pairs = [new("tags", tags), new("context", context), new("durationMs", durationMs)];
    public string Message => message;  public string[] Tags => tags;
    public IReadOnlyDictionary<string, object?>? Context => context;  public double? DurationMs => durationMs;
    public int Count => _pairs.Length;
    public KeyValuePair<string, object?> this[int index] => _pairs[index];
    public IEnumerator<KeyValuePair<string, object?>> GetEnumerator() => ((IEnumerable<KeyValuePair<string, object?>>)_pairs).GetEnumerator();
    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    public override string ToString() => message;
}
```
Usage: `_logger.Info(["auth", "login"], "Login success", new { userId = 42 }, 12);` and `_logger.Error(["payment"], "Charge failed", ex, new { orderId });`.

## 6. Legacy calls get the tag `legacy`
Any entry whose state isn't a `TaggedState` gets `tags: ["legacy"]` from `LogShape.Tags`. That covers `_logger.LogInformation("Order {OrderId} placed", id)`, `[LoggerMessage]` methods, and ASP.NET Core and EF logs. Their template values become `context` (`{"OrderId":7}`), and `{OriginalFormat}` is dropped. Don't rewrite these calls in bulk; convert them when the AI touches the code.

## 7. Ban raw logging, with the existing calls frozen
Add `Microsoft.CodeAnalysis.BannedApiAnalyzers`, the `AdditionalFiles` item and `WarningsAsErrors RS0030` from the sample's `packages.snippet.xml`, but not its Serilog packages. In `BannedSymbols.txt`, keep the sample's `System.Console.WriteLine` lines and replace the `Serilog.Log` lines with:
```text
T:Microsoft.Extensions.Logging.LoggerExtensions;Use logger.Info/Debug/Warn/Error(tags, ...) from TaggedLogger
T:Microsoft.Extensions.Logging.LoggerMessage;Use logger.Info/Debug/Warn/Error(tags, ...) from TaggedLogger
T:Microsoft.Extensions.Logging.LoggerMessageAttribute;Use logger.Info/Debug/Warn/Error(tags, ...) from TaggedLogger
```
A `T:` entry bans every member of the type, including extension calls such as `logger.LogInformation(...)`. It may not be reported on `[LoggerMessage]` attribute usages (verify). The wrapper calls the `ILogger.Log<TState>` interface method and the middleware calls `ILogger.BeginScope<TState>`; neither is banned. To freeze the existing call sites, list them in `.editorconfig` and remove a file from the list when it is touched:
```ini
# Legacy raw logging, shrink only. List: dotnet build 2>&1 | grep RS0030 | sed -E 's/\(.*//' | sort -u  (make paths relative)
[{src/Orders/OrderService.cs,src/Billing/InvoiceJob.cs}]
dotnet_diagnostic.RS0030.severity = suggestion
```

## 8. Checklist
```bash
curl -si localhost:5000/health | grep -i x-correlation-id                                      # generated (TraceId / UUIDv7)
curl -si -H 'X-Correlation-Id: cid-check-123' localhost:5000/health | grep -i x-correlation-id   # echoed
ASPNETCORE_ENVIRONMENT=Production dotnet run > app.log   # repeat both curls
grep '"correlationId":"cid-check-123"' app.log           # "Request started" + "Request finished" (+ app lines)
jq -c 'select((.tags|length)==0 or (.level|test("^(debug|info|warn|error)$")|not))' app.log   # prints nothing
grep -c '"Category"\|"LogLevel"' app.log                # 0: the built-in JSON formatter is no longer active
grep -m3 '"tags":\["legacy"\]' app.log; grep -m1 '"correlationId":"none"' app.log            # untagged / startup
```
- [ ] Each line is one JSON object: `timestamp` ends in `.fffZ`, `logger` is the category, and `error.stack` includes inner exceptions. In Development the line is `09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success userId=42 (12ms)`.
- [ ] The downstream service receives the same `X-Correlation-Id`. A new `_logger.LogInformation(...)` in a file outside the `.editorconfig` list fails the build with RS0030.
