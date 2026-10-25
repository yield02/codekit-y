package com.example.logging;

import org.springframework.http.client.ClientHttpRequestInterceptor;
import org.springframework.web.reactive.function.client.ClientRequest;
import org.springframework.web.reactive.function.client.ExchangeFilterFunction;

/**
 * Adds the current correlation id as {@code X-Correlation-Id} to outgoing HTTP calls.
 * An explicitly set header is never overwritten.
 *
 * <pre>
 * RestClient.builder().requestInterceptor(CorrelationPropagation.interceptor())
 * new RestTemplateBuilder().additionalInterceptors(CorrelationPropagation.interceptor())
 * WebClient.builder().filter(CorrelationPropagation.webClientFilter())
 * </pre>
 *
 * If spring-webflux is not on the classpath, delete {@link #webClientFilter()} and its imports.
 */
public final class CorrelationPropagation {

    private CorrelationPropagation() {
    }

    /** For RestTemplate and RestClient. */
    public static ClientHttpRequestInterceptor interceptor() {
        return (request, body, execution) -> {
            String id = CorrelationId.current();
            if (id != null && !request.getHeaders().containsKey(CorrelationId.HEADER)) {
                request.getHeaders().set(CorrelationId.HEADER, id);
            }
            return execution.execute(request, body);
        };
    }

    /**
     * For WebClient. Reads MDC on the thread that executes the exchange: fine for calls made from a servlet
     * request thread (e.g. {@code .block()}); fully reactive pipelines need Reactor context propagation.
     */
    public static ExchangeFilterFunction webClientFilter() {
        return (request, next) -> {
            String id = CorrelationId.current();
            if (id == null || request.headers().containsKey(CorrelationId.HEADER)) {
                return next.exchange(request);
            }
            return next.exchange(ClientRequest.from(request).header(CorrelationId.HEADER, id).build());
        };
    }
}
