package com.example.logging;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import net.logstash.logback.marker.ObjectAppendingMarker;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.slf4j.event.Level;

/**
 * The only logging API application code may use. Every entry must carry at least one tag.
 *
 * <pre>
 * private static final TaggedLogger log = TaggedLogger.of(AuthService.class);
 * log.info(List.of("auth", "login"), "Login success", TaggedLogger.ctx("userId", 42), 12);
 * </pre>
 *
 * Tags are put into MDC key {@value #MDC_TAGS} (comma-joined) for the duration of the call. Tags, context and
 * durationMs are also passed as structured arguments ({@link Field}), so LogstashEncoder writes them as real
 * JSON fields ({@code tags} array, {@code context} object, {@code durationMs} number) and
 * {@link PrettyLogLayout} renders them from the event's argument array.
 */
public final class TaggedLogger {

    public static final String MDC_TAGS = "tags";
    static final String FIELD_TAGS = "tags";
    static final String FIELD_CONTEXT = "context";
    static final String FIELD_DURATION = "durationMs";

    private final Logger delegate;

    private TaggedLogger(Logger delegate) {
        this.delegate = delegate;
    }

    public static TaggedLogger of(Class<?> type) {
        return new TaggedLogger(LoggerFactory.getLogger(type));
    }

    /** Ordered context map from alternating keys and values: {@code ctx("userId", 42, "plan", "pro")}. */
    public static Map<String, Object> ctx(Object... keyValues) {
        if (keyValues.length % 2 != 0) {
            throw new IllegalArgumentException("ctx() needs alternating keys and values");
        }
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) {
            map.put(String.valueOf(keyValues[i]), keyValues[i + 1]);
        }
        return map;
    }

    public void debug(List<String> tags, String message) { log(Level.DEBUG, tags, message, null, null, null); }
    public void debug(List<String> tags, String message, Map<String, ?> context) { log(Level.DEBUG, tags, message, context, null, null); }
    public void debug(List<String> tags, String message, Map<String, ?> context, long durationMs) { log(Level.DEBUG, tags, message, context, durationMs, null); }

    public void info(List<String> tags, String message) { log(Level.INFO, tags, message, null, null, null); }
    public void info(List<String> tags, String message, Map<String, ?> context) { log(Level.INFO, tags, message, context, null, null); }
    public void info(List<String> tags, String message, Map<String, ?> context, long durationMs) { log(Level.INFO, tags, message, context, durationMs, null); }

    public void warn(List<String> tags, String message) { log(Level.WARN, tags, message, null, null, null); }
    public void warn(List<String> tags, String message, Map<String, ?> context) { log(Level.WARN, tags, message, context, null, null); }
    public void warn(List<String> tags, String message, Map<String, ?> context, long durationMs) { log(Level.WARN, tags, message, context, durationMs, null); }

    public void error(List<String> tags, String message, Throwable error) { log(Level.ERROR, tags, message, null, null, error); }
    public void error(List<String> tags, String message, Throwable error, Map<String, ?> context) { log(Level.ERROR, tags, message, context, null, error); }

    private void log(Level level, List<String> tags, String message, Map<String, ?> context, Long durationMs, Throwable error) {
        String joinedTags = validateTags(tags); // fail fast even when the level is disabled
        Objects.requireNonNull(message, "message");
        if (!delegate.isEnabledForLevel(level)) {
            return;
        }
        List<Object> args = new ArrayList<>(4);
        args.add(new Field(FIELD_TAGS, tags.toArray(String[]::new)));
        if (context != null && !context.isEmpty()) {
            args.add(new Field(FIELD_CONTEXT, new LinkedHashMap<>(context)));
        }
        if (durationMs != null) {
            args.add(new Field(FIELD_DURATION, durationMs));
        }
        if (error != null) {
            args.add(error); // last argument: SLF4J/Logback treat a trailing Throwable as the event's exception
        }
        Object[] argArray = args.toArray();

        String previousTags = MDC.get(MDC_TAGS);
        MDC.put(MDC_TAGS, joinedTags);
        try {
            switch (level) {
                case DEBUG -> delegate.debug(message, argArray);
                case INFO -> delegate.info(message, argArray);
                case WARN -> delegate.warn(message, argArray);
                case ERROR -> delegate.error(message, argArray);
                default -> delegate.trace(message, argArray);
            }
        } finally {
            if (previousTags == null) {
                MDC.remove(MDC_TAGS);
            } else {
                MDC.put(MDC_TAGS, previousTags);
            }
        }
    }

    private static String validateTags(List<String> tags) {
        if (tags == null || tags.isEmpty()) {
            throw new IllegalArgumentException("Log entry requires at least one tag");
        }
        for (String tag : tags) {
            if (tag == null || tag.isBlank() || tag.indexOf(',') >= 0) {
                throw new IllegalArgumentException("Invalid log tag: '" + tag + "' (must be non-blank, without commas)");
            }
        }
        return String.join(",", tags);
    }

    /**
     * Structured argument: written as a JSON field by LogstashEncoder (ArgumentsJsonProvider) and read back
     * by {@link PrettyLogLayout} through {@link #value()}.
     */
    public static final class Field extends ObjectAppendingMarker {
        Field(String name, Object value) {
            super(name, value);
        }

        public Object value() {
            return getFieldValue();
        }
    }
}
