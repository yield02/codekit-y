using System.Globalization;
using System.IO;
using System.Linq;
using Serilog.Events;
using Serilog.Formatting;
using Serilog.Formatting.Json;

namespace Codekit.Logging;

/// <summary>
/// Production format: one JSON object per line with the convention's field names
/// (timestamp, level, service, logger, correlationId, tags, message, context, durationMs, error).
/// </summary>
public sealed class JsonLogFormatter : ITextFormatter
{
    private static readonly JsonValueFormatter ValueFormatter = new(null); // null = no "$type" tags

    public void Format(LogEvent logEvent, TextWriter output)
    {
        output.Write("{\"timestamp\":\"");
        output.Write(logEvent.Timestamp.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture));
        output.Write("\",\"level\":\"");
        output.Write(LogFields.Level(logEvent.Level));
        output.Write("\",\"service\":");
        JsonValueFormatter.WriteQuotedJsonString(LogFields.GetString(logEvent, LogFields.Service) ?? "unknown", output);
        output.Write(",\"logger\":");
        JsonValueFormatter.WriteQuotedJsonString(LogFields.GetString(logEvent, Serilog.Core.Constants.SourceContextPropertyName) ?? "unknown", output);
        output.Write(",\"correlationId\":");
        JsonValueFormatter.WriteQuotedJsonString(LogFields.GetString(logEvent, LogFields.CorrelationId) ?? CorrelationId.None, output);

        output.Write(",\"tags\":[");
        var tags = LogFields.GetTags(logEvent);
        for (var i = 0; i < tags.Count; i++)
        {
            if (i > 0) output.Write(',');
            JsonValueFormatter.WriteQuotedJsonString(tags[i], output);
        }

        output.Write("],\"message\":");
        JsonValueFormatter.WriteQuotedJsonString(logEvent.RenderMessage(CultureInfo.InvariantCulture), output);

        WriteContext(logEvent, output);

        if (logEvent.Properties.TryGetValue(LogFields.DurationMs, out var duration))
        {
            output.Write(",\"durationMs\":");
            ValueFormatter.Format(duration, output);
        }

        if (logEvent.Exception is { } ex)
        {
            output.Write(",\"error\":{\"type\":");
            JsonValueFormatter.WriteQuotedJsonString(ex.GetType().FullName ?? ex.GetType().Name, output);
            output.Write(",\"message\":");
            JsonValueFormatter.WriteQuotedJsonString(ex.Message, output);
            output.Write(",\"stack\":");
            JsonValueFormatter.WriteQuotedJsonString(ex.ToString(), output); // includes inner exceptions
            output.Write('}');
        }

        output.Write('}');
        output.WriteLine();
    }

    private static void WriteContext(LogEvent logEvent, TextWriter output)
    {
        // Entries from TaggedLogger carry an explicit "context" property.
        if (logEvent.Properties.TryGetValue(LogFields.Context, out var context))
        {
            output.Write(",\"context\":");
            ValueFormatter.Format(context, output);
            return;
        }

        // Framework/library entries: keep their template properties as context.
        var extras = logEvent.Properties.Where(p => !LogFields.Reserved.Contains(p.Key)).ToList();
        if (extras.Count == 0) return;

        output.Write(",\"context\":{");
        for (var i = 0; i < extras.Count; i++)
        {
            if (i > 0) output.Write(',');
            JsonValueFormatter.WriteQuotedJsonString(extras[i].Key, output);
            output.Write(':');
            ValueFormatter.Format(extras[i].Value, output);
        }

        output.Write('}');
    }
}
