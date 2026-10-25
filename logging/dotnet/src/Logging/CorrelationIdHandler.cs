using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Codekit.Logging;

/// <summary>Adds the current correlation id to every outgoing request as <c>X-Correlation-Id</c>.</summary>
public sealed class CorrelationIdHandler : DelegatingHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var id = CorrelationId.Current;
        if (!string.IsNullOrEmpty(id) && !request.Headers.Contains(CorrelationId.HeaderName))
        {
            request.Headers.TryAddWithoutValidation(CorrelationId.HeaderName, id);
        }

        return base.SendAsync(request, cancellationToken);
    }
}

public static class CorrelationIdHttpClientBuilderExtensions
{
    /// <summary><c>services.AddHttpClient("payments").AddCorrelationIdPropagation();</c></summary>
    public static IHttpClientBuilder AddCorrelationIdPropagation(this IHttpClientBuilder builder)
    {
        builder.Services.TryAddTransient<CorrelationIdHandler>();
        return builder.AddHttpMessageHandler<CorrelationIdHandler>();
    }
}
