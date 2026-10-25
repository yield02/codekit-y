// Minimal API wiring for the codekit logging convention. Merge into the project's Program.cs.
using System.Diagnostics;
using Codekit.Logging;

var builder = WebApplication.CreateBuilder(args);

builder.Host.UseCodekitLogging();

// Every outgoing HttpClient gets X-Correlation-Id.
builder.Services
    .AddHttpClient("rates", client => client.BaseAddress = new Uri("https://rates.example.com"))
    .AddCorrelationIdPropagation();

var app = builder.Build();

app.UseCorrelationId(); // first, so every later log line carries the correlationId

var log = TaggedLogger.For<Program>();

app.MapPost("/login", (LoginRequest request) =>
{
    var start = Stopwatch.GetTimestamp();

    if (request.Password != "demo")
    {
        // Never log secrets or full personal data: no password, no email.
        log.Warn(["auth", "login"], "Login rejected", new { reason = "invalid_credentials" });
        return Results.Unauthorized();
    }

    const int userId = 42;
    log.Info(["auth", "login"], "Login success", new { userId }, Stopwatch.GetElapsedTime(start).TotalMilliseconds);
    // Development: 09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success userId=42 (0ms)
    return Results.Ok(new { userId });
});

app.MapGet("/rates", async (IHttpClientFactory httpClientFactory) =>
{
    var start = Stopwatch.GetTimestamp();
    try
    {
        var json = await httpClientFactory.CreateClient("rates").GetStringAsync("/latest");
        log.Info(["rates", "external"], "Rates fetched", new { provider = "rates" }, Stopwatch.GetElapsedTime(start).TotalMilliseconds);
        return Results.Content(json, "application/json");
    }
    catch (HttpRequestException ex)
    {
        log.Error(["rates", "external"], "Rates provider call failed", ex, new { provider = "rates", status = (int?)ex.StatusCode },
            Stopwatch.GetElapsedTime(start).TotalMilliseconds);
        return Results.StatusCode(StatusCodes.Status502BadGateway);
    }
});

app.Run();

internal sealed record LoginRequest(string Email, string Password);
