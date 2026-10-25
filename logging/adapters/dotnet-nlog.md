# Adopting the convention in an NLog project

Reuse these from `logging/dotnet/src/Logging/`: `CorrelationId.cs`, `CorrelationIdMiddleware.cs` and `CorrelationIdHandler.cs`, plus `ValidateTags`/`ToDictionary` from `TaggedLogger.cs`. Don't copy the Serilog-only files (`JsonLogFormatter.cs`, `PrettyLogFormatter.cs`, `LogFields.cs`, `LoggingSetup.cs`) or the Serilog packages in `packages.snippet.xml`. NLog stays the only logging library.

## 1. When this applies
- **Packages:** `NLog`, `NLog.Web.AspNetCore`, `NLog.Extensions.Logging`, `NLog.Schema`. This guide assumes NLog **5.x** (`ScopeContext`, `finalMinLevel`).
- **Config:** `nlog.config` / `NLog.config` (often with `CopyToOutputDirectory`), or an `"NLog"` section in `appsettings*.json`.
- **Code:** `LogManager.GetCurrentClassLogger()`, `LogManager.Setup()`, `builder.Host.UseNLog()` / `builder.Logging.AddNLogWeb()`, `MappedDiagnosticsLogicalContext`, `ScopeContext`.
- **Which wrapper:** pick it by how the existing code gets its loggers.
  - NLog `Logger` fields: use section 5 below.
  - Injected `ILogger<T>`, with NLog only as the MEL provider: use the extensions from `dotnet-microsoft-logging.md` section 5. They work unchanged, because NLog's MEL provider turns the state's key/value pairs into event properties (`tags`, `context`, `durationMs`) and uses the formatter output as the message (verify).
  - Never use both.

## 2. correlationId with ScopeContext
- `CorrelationId.cs`: replace `using Serilog.Context;` with `using NLog;`, and `LogContext.PushProperty(PropertyName, id)` with `ScopeContext.PushProperty(PropertyName, id)`. Everything else stays as it is: header validation, Activity TraceId, UUIDv7 and the AsyncLocal `Current`.
- `CorrelationIdMiddleware.cs` and `CorrelationIdHandler.cs`: no changes. The NLog `TaggedLogger` keeps `For<T>()` and `Info/Warn/Error`.
- MEL `ILogger.BeginScope(...)` also lands in `ScopeContext`, because the NLog provider's `IncludeScopes` defaults to true. `${scopeproperty:item=correlationId}` therefore sees both.
- Jobs and consumers: `using var _ = CorrelationId.BeginScope(incomingHeaderOrNull);`, as in the sample README.

## 3. JSON output
**Renderers and startup (`CodekitNLog.cs`, `Program.cs`).** The built-in `${level}` can't map Trace to debug or Fatal to error, and nothing provides a default for a missing array. Register these small renderers **before** the config is loaded:
```csharp
using System.Globalization;
using System.Text;
using System.Text.Json;
using NLog;

public static class CodekitNLog
{
    public const string LegacyTag = "legacy";

    public static void Register(NLog.Config.ISetupExtensionsBuilder ext) => ext
        .RegisterLayoutRenderer("codekit-level", e => Level(e.Level))
        .RegisterLayoutRenderer("codekit-tags", e => JsonSerializer.Serialize(Tags(e)))   // JSON array
        .RegisterLayoutRenderer("codekit-tags-csv", e => string.Join(',', Tags(e)))
        .RegisterLayoutRenderer("codekit-tail", Tail);                                     // pretty: ctx, (Nms), error

    static string Level(LogLevel l) =>
        l >= LogLevel.Error ? "error" : l == LogLevel.Warn ? "warn" : l == LogLevel.Info ? "info" : "debug";

    static string[] Tags(LogEventInfo e) =>
        e.HasProperties && e.Properties.TryGetValue("tags", out var t) && t is string[] { Length: > 0 } a ? a : [LegacyTag];

    static string Tail(LogEventInfo e)
    {
        var sb = new StringBuilder();
        if (e.HasProperties && e.Properties.TryGetValue("context", out var c) && c is IReadOnlyDictionary<string, object?> ctx)
            foreach (var (k, v) in ctx) sb.Append(' ').Append(k).Append('=').Append(Convert.ToString(v, CultureInfo.InvariantCulture));
        if (e.HasProperties && e.Properties.TryGetValue("durationMs", out var d) && d is double ms)
            sb.Append(" (").Append(ms.ToString("0", CultureInfo.InvariantCulture)).Append("ms)");
        if (e.Exception is { } ex) sb.Append(" error=").Append(ex.GetType().FullName).Append(": ").Append(ex.Message);
        return sb.ToString();
    }
}
```
```csharp
// Program.cs (using NLog; using NLog.Web;): first lines, before anything logs
var env = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") ?? "Production";
LogManager.Setup()
    .SetupExtensions(CodekitNLog.Register)
    .LoadConfigurationFromFile(Path.Combine(AppContext.BaseDirectory, env == "Development" ? "nlog.Development.config" : "nlog.config"));
var builder = WebApplication.CreateBuilder(args);
GlobalDiagnosticsContext.Set("service", builder.Environment.ApplicationName);
builder.Logging.ClearProviders();
builder.Host.UseNLog();
builder.Services.AddHttpClient("rates").AddCorrelationIdPropagation();   // CorrelationIdHandler.cs
var app = builder.Build();
app.UseCorrelationId();                                                  // first middleware
```
If the project loads its config with `LoadConfigurationFromAppSettings()`, keep that call and insert `.SetupExtensions(CodekitNLog.Register)` before it.

**`nlog.config` (production):**
```xml
<nlog xmlns="http://www.nlog-project.org/schemas/NLog.xsd"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" throwConfigExceptions="true">
  <targets>
    <target xsi:type="Console" name="console">
      <layout xsi:type="JsonLayout" suppressSpaces="true">
        <attribute name="timestamp" layout="${date:universalTime=true:format=yyyy-MM-ddTHH\:mm\:ss.fff}Z" />
        <attribute name="level" layout="${codekit-level}" />
        <attribute name="service" layout="${gdc:item=service:whenEmpty=unknown}" />
        <attribute name="logger" layout="${logger}" />
        <attribute name="correlationId" layout="${scopeproperty:item=correlationId:whenEmpty=none}" />
        <attribute name="tags" layout="${codekit-tags}" encode="false" />
        <attribute name="message" layout="${message}" />
        <attribute name="context" layout="${event-properties:item=context:format=@}" encode="false" />
        <attribute name="durationMs" layout="${event-properties:item=durationMs:format=@}" encode="false" />
        <attribute name="error" encode="false">
          <layout xsi:type="JsonLayout" suppressSpaces="true" renderEmptyObject="false">
            <attribute name="type" layout="${exception:format=Type}" />
            <attribute name="message" layout="${exception:format=Message}" />
            <attribute name="stack" layout="${exception:format=ToString}" />  <!-- includes inner exceptions -->
          </layout>
        </attribute>
      </layout>
    </target>
  </targets>
  <rules>
    <logger name="Microsoft.*" finalMinLevel="Warn" />
    <logger name="System.Net.Http.HttpClient.*" finalMinLevel="Warn" />
    <logger name="Microsoft.Hosting.Lifetime*" finalMinLevel="Info" />
    <logger name="*" minlevel="Info" writeTo="console" />
  </rules>
</nlog>
```
- Empty attributes are skipped, because `includeEmptyValue` defaults to false. So `context`, `durationMs` and `error` appear only when they have a value.
- `renderEmptyObject="false"` makes the nested error layout render nothing when there is no exception (verify).
- `format=@` writes the dictionary or number as JSON with invariant culture.
- Keep the project's other targets (files, DB). Change their layout only if they are also shipped to log search.

## 4. Dev pretty output (`nlog.Development.config`)
Use the same file with this target, and set `minlevel="Debug"` on the catch-all rule:
```xml
<target xsi:type="Console" name="console"
        layout="${date:format=HH\:mm\:ss.fff} ${codekit-level:uppercase=true:padding=-5} [cid=${right:inner=${scopeproperty:item=correlationId:whenEmpty=none}:length=8}] [${codekit-tags-csv}] ${message}${codekit-tail}${onexception:inner=${newline}${exception:format=ToString}}" />
```
This prints `09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success userId=42 (12ms)`, and any stack trace goes on the following lines. `${right}` exists since NLog 4.6 (verify). Mark both config files `CopyToOutputDirectory=PreserveNewest`.

## 5. Tagged wrapper (`TaggedLogger.cs`, NLog version)
It keeps the sample's public API. Copy `ValidateTags` and `ToDictionary` verbatim from the sample `TaggedLogger.cs`.
```csharp
#pragma warning disable RS0030 // the one place allowed to touch NLog.Logger
using NLog;

public sealed class TaggedLogger
{
    private readonly Logger _logger;
    private TaggedLogger(string name) => _logger = LogManager.GetLogger(name);
    public static TaggedLogger For<T>() => new(typeof(T).FullName ?? typeof(T).Name);
    public static TaggedLogger For(string name) => new(name);

    public void Debug(IReadOnlyList<string> tags, string message, object? context = null, double? durationMs = null) => Write(LogLevel.Debug, tags, message, null, context, durationMs);
    public void Info(IReadOnlyList<string> tags, string message, object? context = null, double? durationMs = null) => Write(LogLevel.Info, tags, message, null, context, durationMs);
    public void Warn(IReadOnlyList<string> tags, string message, object? context = null, double? durationMs = null) => Write(LogLevel.Warn, tags, message, null, context, durationMs);
    public void Error(IReadOnlyList<string> tags, string message, Exception? exception, object? context = null, double? durationMs = null) => Write(LogLevel.Error, tags, message, exception, context, durationMs);

    private void Write(LogLevel level, IReadOnlyList<string> tags, string message, Exception? exception, object? context, double? durationMs)
    {
        ValidateTags(tags);                       // throws even when the level is disabled
        ArgumentNullException.ThrowIfNull(message);
        if (!_logger.IsEnabled(level)) return;
        // No parameters, so NLog doesn't parse the message as a template: the text is logged literally.
        var e = new LogEventInfo(level, _logger.Name, message) { Exception = exception };
        e.Properties["tags"] = tags.ToArray();
        if (ToDictionary(context) is { Count: > 0 } ctx) e.Properties["context"] = ctx;
        if (durationMs is { } ms) e.Properties["durationMs"] = Math.Round(ms, 2);
        _logger.Log(typeof(TaggedLogger), e);    // wrapperType keeps ${callsite} pointing at the caller
    }
    // ValidateTags(...) and ToDictionary(...) copied from the sample
}
```
Usage: `private static readonly TaggedLogger Log = TaggedLogger.For<LoginService>(); Log.Info(["auth", "login"], "Login success", new { userId = 42 }, 12);`

## 6. Legacy calls get the tag `legacy`
`codekit-tags` returns `["legacy"]` for every event that has no `tags` property. That covers `LogManager.GetCurrentClassLogger().Info("Order {OrderId}", id)`, `ILogger<T>.LogInformation(...)`, and ASP.NET Core and EF logs. These entries still carry timestamp/level/service/logger/correlationId/message/error. Don't rewrite them in bulk. Convert them when the AI touches the code.

## 7. Ban raw logging, with the existing calls frozen
Add `Microsoft.CodeAnalysis.BannedApiAnalyzers`, the `AdditionalFiles` item and `WarningsAsErrors RS0030` from the sample's `packages.snippet.xml`. For `BannedSymbols.txt`, keep the sample's `System.Console.WriteLine` lines and replace the `Serilog.Log` lines with:
```text
M:NLog.LogManager.GetCurrentClassLogger;Use TaggedLogger.For<T>() (mandatory tags)
M:NLog.LogManager.GetLogger(System.String);Use TaggedLogger.For<T>() (mandatory tags)
T:NLog.Logger;Use TaggedLogger (mandatory tags)
T:Microsoft.Extensions.Logging.LoggerExtensions;Use TaggedLogger (mandatory tags) instead of ILogger.LogXxx
```
A `T:` entry bans every member of the type (verify on the first build). Existing call sites shouldn't fail the build: list them in `.editorconfig`, and remove a file from the list when it is touched.
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
grep -m3 '"tags":\["legacy"\]' app.log; grep -m1 '"correlationId":"none"' app.log            # untagged / startup
```
- [ ] Each line is one compact JSON object. `timestamp` ends in `.fffZ`, `durationMs` is a number, and `error.stack` includes inner exceptions.
- [ ] The Development console shows `09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success userId=42 (12ms)`.
- [ ] The downstream service receives the same `X-Correlation-Id`. A new `LogManager.GetCurrentClassLogger()` fails the build with RS0030.
- [ ] Startup succeeds with `throwConfigExceptions="true"`. An unregistered `${codekit-*}` renderer fails loudly here instead of silently.
