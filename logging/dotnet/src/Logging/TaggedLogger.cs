using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Serilog;
using Serilog.Events;

namespace Codekit.Logging;

/// <summary>
/// The only logging API application code should use. Every entry needs at least one tag (from the tag registry).
/// <code>
/// private static readonly TaggedLogger Log = TaggedLogger.For&lt;LoginService&gt;();
/// Log.Info(["auth", "login"], "Login success", new { userId = 42 });
/// </code>
/// <paramref name="context"/> arguments accept an anonymous object or an IReadOnlyDictionary&lt;string, object?&gt;.
/// </summary>
public sealed class TaggedLogger
{
    // Constant template: user text is never parsed as a message template. ":l" renders the string without quotes.
    private const string Template = "{" + LogFields.Message + ":l}";

    private readonly string _source;

    private TaggedLogger(string source) => _source = source;

    public static TaggedLogger For<T>() => new(typeof(T).FullName ?? typeof(T).Name);

    public static TaggedLogger For(string source) => new(source);

    public void Debug(IReadOnlyList<string> tags, string message, object? context = null, double? durationMs = null) =>
        Write(LogEventLevel.Debug, tags, message, null, context, durationMs);

    public void Info(IReadOnlyList<string> tags, string message, object? context = null, double? durationMs = null) =>
        Write(LogEventLevel.Information, tags, message, null, context, durationMs);

    public void Warn(IReadOnlyList<string> tags, string message, object? context = null, double? durationMs = null) =>
        Write(LogEventLevel.Warning, tags, message, null, context, durationMs);

    public void Error(IReadOnlyList<string> tags, string message, Exception? exception, object? context = null, double? durationMs = null) =>
        Write(LogEventLevel.Error, tags, message, exception, context, durationMs);

    private void Write(LogEventLevel level, IReadOnlyList<string> tags, string message, Exception? exception, object? context, double? durationMs)
    {
        ValidateTags(tags);
        ArgumentNullException.ThrowIfNull(message);

        // Resolve Log.Logger on every call so loggers created in static fields before host startup still work.
        var logger = Log.Logger.ForContext(Serilog.Core.Constants.SourceContextPropertyName, _source);
        if (!logger.IsEnabled(level))
        {
            return;
        }

        logger = logger.ForContext(LogFields.Tags, tags.ToArray());

        var ctx = ToDictionary(context);
        if (ctx is { Count: > 0 })
        {
            logger = logger.ForContext(LogFields.Context, ctx, destructureObjects: true);
        }

        if (durationMs is { } ms)
        {
            logger = logger.ForContext(LogFields.DurationMs, Math.Round(ms, 2));
        }

        logger.Write(level, exception, Template, message);
    }

    private static void ValidateTags(IReadOnlyList<string>? tags)
    {
        if (tags is null || tags.Count == 0)
        {
            throw new ArgumentException("At least one log tag is required.", nameof(tags));
        }

        foreach (var tag in tags)
        {
            if (string.IsNullOrWhiteSpace(tag))
            {
                throw new ArgumentException("Log tags must not be null or blank.", nameof(tags));
            }
        }
    }

    private static IReadOnlyDictionary<string, object?>? ToDictionary(object? context) => context switch
    {
        null => null,
        IReadOnlyDictionary<string, object?> d => d,
        IDictionary d => d.Keys.Cast<object>().ToDictionary(k => k.ToString() ?? "", k => d[k]),
        _ => context.GetType()
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.GetIndexParameters().Length == 0)
            .ToDictionary(p => p.Name, p => p.GetValue(context)),
    };
}
