package com.example.logging;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Map;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.classic.spi.ThrowableProxyUtil;
import ch.qos.logback.core.CoreConstants;
import ch.qos.logback.core.LayoutBase;

/**
 * Development layout, one line per entry:
 * {@code 09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success userId=42 (12ms)}
 * Stack traces (if any) follow on the next lines.
 */
public class PrettyLogLayout extends LayoutBase<ILoggingEvent> {

    private static final DateTimeFormatter TIME =
            DateTimeFormatter.ofPattern("HH:mm:ss.SSS").withZone(ZoneId.systemDefault());

    @Override
    public String doLayout(ILoggingEvent event) {
        Map<String, String> mdc = event.getMDCPropertyMap();
        StringBuilder sb = new StringBuilder(160)
                .append(TIME.format(Instant.ofEpochMilli(event.getTimeStamp()))).append(' ')
                .append(String.format("%-5s", event.getLevel())).append(' ')
                .append("[cid=").append(shortId(mdc.get(CorrelationId.MDC_KEY))).append("] ")
                .append('[').append(orDash(mdc.get(TaggedLogger.MDC_TAGS))).append("] ")
                .append(event.getFormattedMessage());

        Object duration = null;
        Object[] args = event.getArgumentArray();
        if (args != null) {
            for (Object arg : args) {
                if (!(arg instanceof TaggedLogger.Field field)) {
                    continue;
                }
                switch (field.getFieldName()) {
                    case TaggedLogger.FIELD_CONTEXT -> ((Map<?, ?>) field.value())
                            .forEach((k, v) -> sb.append(' ').append(k).append('=').append(v));
                    case TaggedLogger.FIELD_DURATION -> duration = field.value();
                    default -> { } // tags are rendered from MDC above
                }
            }
        }
        if (duration != null) {
            sb.append(" (").append(duration).append("ms)");
        }
        sb.append(CoreConstants.LINE_SEPARATOR);

        IThrowableProxy throwable = event.getThrowableProxy();
        if (throwable != null) {
            sb.append(ThrowableProxyUtil.asString(throwable)); // already newline-terminated
        }
        return sb.toString();
    }

    /** Last 8 characters of the correlation id, enough to follow one request in a dev console. */
    private static String shortId(String correlationId) {
        if (correlationId == null || correlationId.isEmpty()) {
            return "-";
        }
        return correlationId.length() <= 8 ? correlationId : correlationId.substring(correlationId.length() - 8);
    }

    private static String orDash(String value) {
        return value == null || value.isEmpty() ? "-" : value;
    }
}
