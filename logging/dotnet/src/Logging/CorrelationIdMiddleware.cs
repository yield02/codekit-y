using System;
using System.Diagnostics;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;

namespace Codekit.Logging;

/// <summary>
/// HTTP entry point: resolves the correlation id, scopes it to the request (AsyncLocal + Serilog LogContext +
/// HttpContext.Items), echoes it in the response header and logs request in/out with the "http" tag.
/// Register it first in the pipeline so every later log line carries the id.
/// </summary>
public sealed class CorrelationIdMiddleware
{
    private static readonly TaggedLogger Log = TaggedLogger.For<CorrelationIdMiddleware>();
    private static readonly string[] HttpTags = ["http"];
    private static readonly double SlowRequestMs =
        double.TryParse(Environment.GetEnvironmentVariable("LOG_SLOW_REQUEST_MS"), out var ms) ? ms : 1000;

    private readonly RequestDelegate _next;

    public CorrelationIdMiddleware(RequestDelegate next) => _next = next;

    public async Task InvokeAsync(HttpContext context)
    {
        string? incoming = context.Request.Headers[CorrelationId.HeaderName];
        var id = CorrelationId.Resolve(incoming);

        context.Items[CorrelationId.ItemKey] = id;
        context.Response.OnStarting(() =>
        {
            context.Response.Headers[CorrelationId.HeaderName] = id;
            return Task.CompletedTask;
        });

        using var scope = CorrelationId.BeginScope(id);

        var method = context.Request.Method;
        var path = context.Request.Path.Value ?? "/"; // never log the query string: it may hold secrets
        var start = Stopwatch.GetTimestamp();

        // One info line per request; "started" only at debug. Disable Microsoft.AspNetCore request logging to avoid duplicates.
        Log.Debug(HttpTags, "Request started", new { method, path });
        try
        {
            await _next(context);
        }
        catch (Exception ex)
        {
            // Unhandled here means nobody logged it yet: this is the single error line for the failure.
            Log.Error(HttpTags, "Request failed", ex, new { method, path, status = StatusCodes.Status500InternalServerError },
                Stopwatch.GetElapsedTime(start).TotalMilliseconds);
            throw;
        }

        var elapsed = Stopwatch.GetElapsedTime(start).TotalMilliseconds;
        var ctx = new { method, path, status = context.Response.StatusCode };
        if (elapsed > SlowRequestMs)
            Log.Warn(HttpTags, "Slow request", ctx, elapsed);
        else
            Log.Info(HttpTags, "Request finished", ctx, elapsed);
    }
}

public static class CorrelationIdApplicationBuilderExtensions
{
    public static IApplicationBuilder UseCorrelationId(this IApplicationBuilder app) =>
        app.UseMiddleware<CorrelationIdMiddleware>();

    /// <summary>The correlation id of this request, set by <see cref="CorrelationIdMiddleware"/>.</summary>
    public static string? GetCorrelationId(this HttpContext context) =>
        context.Items.TryGetValue(CorrelationId.ItemKey, out var value) ? value as string : null;
}
