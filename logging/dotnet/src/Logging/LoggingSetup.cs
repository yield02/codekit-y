using Microsoft.Extensions.Hosting;
using Serilog;
using Serilog.Events;
using Serilog.Formatting;

namespace Codekit.Logging;

public static class LoggingSetup
{
    /// <summary>
    /// <c>builder.Host.UseCodekitLogging();</c> Console output: pretty lines in Development, JSON lines elsewhere.
    /// <c>service</c> is IHostEnvironment.ApplicationName.
    /// </summary>
    public static IHostBuilder UseCodekitLogging(this IHostBuilder host) =>
        host.UseSerilog((context, _, config) =>
        {
            var env = context.HostingEnvironment;
            ITextFormatter formatter = env.IsDevelopment() ? new PrettyLogFormatter() : new JsonLogFormatter();

            config
                .MinimumLevel.Is(env.IsDevelopment() ? LogEventLevel.Debug : LogEventLevel.Information)
                // CorrelationIdMiddleware already logs request in/out; keep framework noise down.
                .MinimumLevel.Override("Microsoft", LogEventLevel.Warning)
                .MinimumLevel.Override("Microsoft.Hosting.Lifetime", LogEventLevel.Information)
                .MinimumLevel.Override("System.Net.Http.HttpClient", LogEventLevel.Warning)
                .Enrich.FromLogContext()
                .Enrich.WithProperty(LogFields.Service, env.ApplicationName)
                .WriteTo.Console(formatter);
        });
}
