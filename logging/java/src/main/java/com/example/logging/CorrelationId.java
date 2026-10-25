package com.example.logging;

import java.security.SecureRandom;
import java.util.UUID;
import java.util.regex.Pattern;

import org.slf4j.MDC;

/**
 * Correlation id resolution: incoming header, then the active OpenTelemetry trace id, then a new UUIDv7.
 */
public final class CorrelationId {

    public static final String HEADER = "X-Correlation-Id";
    public static final String MDC_KEY = "correlationId";

    /** Accept only safe characters from callers so the header cannot inject content into logs. */
    private static final Pattern SAFE_ID = Pattern.compile("[A-Za-z0-9._:-]{1,128}");
    private static final SecureRandom RANDOM = new SecureRandom();

    private CorrelationId() {
    }

    /** The correlation id of the current request/thread, or {@code null} outside a request. */
    public static String current() {
        return MDC.get(MDC_KEY);
    }

    /** Resolves the id for an entry point; {@code incoming} is the raw header value (may be null). */
    public static String resolve(String incoming) {
        if (incoming != null && SAFE_ID.matcher(incoming.trim()).matches()) {
            return incoming.trim();
        }
        String traceId = otelTraceId();
        return traceId != null ? traceId : uuidV7();
    }

    private static volatile boolean otelAvailable = true;

    /** Trace id of the current valid OpenTelemetry span, or {@code null} (no span, or OTel API absent). */
    static String otelTraceId() {
        if (!otelAvailable) {
            return null;
        }
        try {
            return OpenTelemetry.currentTraceId();
        } catch (NoClassDefFoundError e) {
            otelAvailable = false; // OTel API not on the classpath: stop trying
            return null;
        }
    }

    /** RFC 9562 UUIDv7: 48-bit unix ms timestamp, version 7, variant 10, remaining 74 bits random. */
    public static String uuidV7() {
        long msb = (System.currentTimeMillis() << 16) | 0x7000L | (RANDOM.nextInt() & 0x0FFFL);
        long lsb = (RANDOM.nextLong() & 0x3FFFFFFFFFFFFFFFL) | 0x8000000000000000L;
        return new UUID(msb, lsb).toString();
    }

    /**
     * Isolates every reference to the optional OpenTelemetry API, so this class is only loaded
     * (and can only fail with NoClassDefFoundError) when {@link #otelTraceId()} calls it.
     */
    private static final class OpenTelemetry {
        static String currentTraceId() {
            io.opentelemetry.api.trace.SpanContext span = io.opentelemetry.api.trace.Span.current().getSpanContext();
            return span.isValid() ? span.getTraceId() : null;
        }
    }
}
