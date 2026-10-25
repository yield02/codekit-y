using System;
using System.Diagnostics;
using System.Linq;
using System.Security.Cryptography;
using System.Threading;
using Serilog.Context;

namespace Codekit.Logging;

/// <summary>
/// Request-scoped correlation id: resolution (header -> OpenTelemetry trace id -> UUIDv7),
/// an AsyncLocal accessor for the current id, and a scope that also pushes it into Serilog's LogContext.
/// </summary>
public static class CorrelationId
{
    public const string HeaderName = "X-Correlation-Id";
    public const string ItemKey = "correlationId";
    public const string PropertyName = "correlationId";

    /// <summary>Written when an entry is logged outside any correlation scope (e.g. startup).</summary>
    public const string None = "none";

    private static readonly AsyncLocal<string?> CurrentId = new();

    /// <summary>The correlation id of the current async flow, or null outside a scope.</summary>
    public static string? Current => CurrentId.Value;

    /// <summary>Incoming value if valid, else the current Activity's TraceId, else a new UUIDv7.</summary>
    public static string Resolve(string? incoming)
    {
        if (incoming is not null && IsValid(incoming))
        {
            return incoming;
        }

        var activity = Activity.Current;
        if (activity is not null && activity.TraceId != default)
        {
            return activity.TraceId.ToHexString();
        }

        return NewUuidV7();
    }

    /// <summary>
    /// Sets the current id for this async flow and pushes it to Serilog's LogContext.
    /// Use at non-HTTP entry points too (queue consumers, jobs): <c>using var _ = CorrelationId.BeginScope(incoming);</c>
    /// </summary>
    public static IDisposable BeginScope(string? incoming = null)
    {
        var id = Resolve(incoming);
        var previous = CurrentId.Value;
        CurrentId.Value = id;
        return new Scope(previous, LogContext.PushProperty(PropertyName, id));
    }

    /// <summary>RFC 9562 UUIDv7: 48-bit unix ms timestamp, version 7, variant 10, remaining bits random.</summary>
    public static string NewUuidV7()
    {
        Span<byte> bytes = stackalloc byte[16];
        RandomNumberGenerator.Fill(bytes[6..]);

        var ms = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        bytes[0] = (byte)(ms >> 40);
        bytes[1] = (byte)(ms >> 32);
        bytes[2] = (byte)(ms >> 24);
        bytes[3] = (byte)(ms >> 16);
        bytes[4] = (byte)(ms >> 8);
        bytes[5] = (byte)ms;
        bytes[6] = (byte)((bytes[6] & 0x0F) | 0x70); // version 7
        bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80); // variant 10

        var hex = Convert.ToHexString(bytes).ToLowerInvariant();
        return $"{hex[..8]}-{hex[8..12]}-{hex[12..16]}-{hex[16..20]}-{hex[20..]}";
    }

    // Reject oversized or unexpected values so a client cannot inject arbitrary text into logs.
    private static bool IsValid(string value) =>
        value.Length is > 0 and <= 128 &&
        value.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.');

    private sealed class Scope(string? previous, IDisposable logContext) : IDisposable
    {
        public void Dispose()
        {
            logContext.Dispose();
            CurrentId.Value = previous;
        }
    }
}
