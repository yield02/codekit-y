using System.Globalization;
using System.IO;
using Serilog.Events;
using Serilog.Formatting;

namespace Codekit.Logging;

/// <summary>
/// Development format, one line per entry:
/// <c>09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success userId=42 (12ms)</c>
/// </summary>
public sealed class PrettyLogFormatter : ITextFormatter
{
    public void Format(LogEvent logEvent, TextWriter output)
    {
        output.Write(logEvent.Timestamp.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture));
        output.Write(' ');
        output.Write(LogFields.Level(logEvent.Level).ToUpperInvariant().PadRight(5));

        var cid = LogFields.GetString(logEvent, LogFields.CorrelationId) ?? CorrelationId.None;
        output.Write(" [cid=");
        output.Write(cid.Length > 8 ? cid[^8..] : cid);
        output.Write("] [");
        output.Write(string.Join(',', LogFields.GetTags(logEvent)));
        output.Write("] ");
        output.Write(logEvent.RenderMessage(CultureInfo.InvariantCulture));

        foreach (var (key, value) in LogFields.GetContext(logEvent))
        {
            output.Write(' ');
            output.Write(key);
            output.Write('=');
            if (value is ScalarValue { Value: string s })
            {
                output.Write(s.Contains(' ') ? $"\"{s}\"" : s);
            }
            else
            {
                value.Render(output, null, CultureInfo.InvariantCulture);
            }
        }

        if (logEvent.Properties.TryGetValue(LogFields.DurationMs, out var duration) &&
            duration is ScalarValue { Value: double ms })
        {
            output.Write(" (");
            output.Write(ms.ToString("0", CultureInfo.InvariantCulture));
            output.Write("ms)");
        }

        output.WriteLine();

        if (logEvent.Exception is not null)
        {
            output.WriteLine(logEvent.Exception.ToString());
        }
    }
}
