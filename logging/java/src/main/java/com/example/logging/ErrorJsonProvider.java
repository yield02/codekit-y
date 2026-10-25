package com.example.logging;

import java.io.IOException;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.classic.spi.ThrowableProxyUtil;
import com.fasterxml.jackson.core.JsonGenerator;
import net.logstash.logback.composite.AbstractFieldJsonProvider;

/**
 * Writes the event's exception as {@code "error": {"type", "message", "stack"}} (the convention's shape)
 * instead of LogstashEncoder's flat {@code stack_trace}. Applies to every event, including framework logs.
 * Uses the Jackson 2 API of logstash-logback-encoder 7.x/8.x (9.x moved to Jackson 3, Spring Boot 4).
 */
public class ErrorJsonProvider extends AbstractFieldJsonProvider<ILoggingEvent> {

    public ErrorJsonProvider() {
        setFieldName("error");
    }

    @Override
    public void writeTo(JsonGenerator generator, ILoggingEvent event) throws IOException {
        IThrowableProxy throwable = event.getThrowableProxy();
        if (throwable == null) {
            return;
        }
        generator.writeObjectFieldStart(getFieldName());
        generator.writeStringField("type", throwable.getClassName());
        generator.writeStringField("message", throwable.getMessage());
        generator.writeStringField("stack", ThrowableProxyUtil.asString(throwable));
        generator.writeEndObject();
    }
}
