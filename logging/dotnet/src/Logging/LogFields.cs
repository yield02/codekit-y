using System.Collections.Generic;
using System.Linq;
using Serilog.Events;

namespace Codekit.Logging;

/// <summary>Property names and read helpers shared by the wrapper and both formatters.</summary>
internal static class LogFields
{
    public const string Service = "service";
    public const string CorrelationId = "correlationId";
    public const string Tags = "tags";
    public const string Context = "context";
    public const string DurationMs = "durationMs";

    /// <summary>Template property holding the plain message (template is the constant "{Message:l}").</summary>
    public const string Message = "Message";

    /// <summary>Tag used for entries not written through TaggedLogger (ASP.NET Core, libraries).</summary>
    public const string FallbackTag = "framework";

    /// <summary>Properties that are never copied into the fallback "context" object.</summary>
    public static readonly HashSet<string> Reserved = new()
    {
        Service, CorrelationId, Tags, Context, DurationMs, Message, Serilog.Core.Constants.SourceContextPropertyName,
    };

    public static string Level(LogEventLevel level) => level switch
    {
        LogEventLevel.Verbose or LogEventLevel.Debug => "debug",
        LogEventLevel.Information => "info",
        LogEventLevel.Warning => "warn",
        _ => "error", // Error and Fatal
    };

    public static string? GetString(LogEvent logEvent, string name) =>
        logEvent.Properties.TryGetValue(name, out var value) && value is ScalarValue { Value: string s } ? s : null;

    public static IReadOnlyList<string> GetTags(LogEvent logEvent) =>
        logEvent.Properties.TryGetValue(Tags, out var value) && value is SequenceValue { Elements.Count: > 0 } seq
            ? seq.Elements.Select(e => e is ScalarValue { Value: string s } ? s : e.ToString()).ToList()
            : new[] { FallbackTag };

    /// <summary>Key/value pairs of the "context" property (DictionaryValue or StructureValue).</summary>
    public static IEnumerable<KeyValuePair<string, LogEventPropertyValue>> GetContext(LogEvent logEvent)
    {
        if (!logEvent.Properties.TryGetValue(Context, out var value))
        {
            return Enumerable.Empty<KeyValuePair<string, LogEventPropertyValue>>();
        }

        return value switch
        {
            DictionaryValue d => d.Elements.Select(kv =>
                new KeyValuePair<string, LogEventPropertyValue>(kv.Key.Value?.ToString() ?? "", kv.Value)),
            StructureValue s => s.Properties.Select(p =>
                new KeyValuePair<string, LogEventPropertyValue>(p.Name, p.Value)),
            _ => Enumerable.Empty<KeyValuePair<string, LogEventPropertyValue>>(),
        };
    }
}
