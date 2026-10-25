package com.example.logging;

import java.io.IOException;
import java.util.List;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Entry point for HTTP requests: resolves the correlation id, stores it in MDC, echoes it in the
 * {@code X-Correlation-Id} response header, logs request in/out, and clears MDC afterwards.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class CorrelationIdFilter extends OncePerRequestFilter {

    private static final TaggedLogger log = TaggedLogger.of(CorrelationIdFilter.class);
    private static final List<String> TAGS = List.of("http");

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String correlationId = CorrelationId.resolve(request.getHeader(CorrelationId.HEADER));
        MDC.put(CorrelationId.MDC_KEY, correlationId);
        response.setHeader(CorrelationId.HEADER, correlationId); // before the body can commit the response

        String method = request.getMethod();
        String path = request.getRequestURI(); // no query string: it may carry PII
        long start = System.nanoTime();
        boolean failed = false;
        log.info(TAGS, "Request in", TaggedLogger.ctx("method", method, "path", path));
        try {
            chain.doFilter(request, response);
        } catch (IOException | ServletException | RuntimeException e) {
            failed = true;
            throw e;
        } finally {
            int status = failed ? HttpServletResponse.SC_INTERNAL_SERVER_ERROR : response.getStatus();
            long durationMs = (System.nanoTime() - start) / 1_000_000;
            log.info(TAGS, "Request out", TaggedLogger.ctx("method", method, "path", path, "status", status), durationMs);
            MDC.remove(CorrelationId.MDC_KEY);
        }
    }
}
