# Adopting the convention in a Log4j2 project

Reuse these from `logging/java/`: `CorrelationId.java`, `CorrelationIdFilter.java`, `CorrelationPropagation.java` and `LoggingArchitectureTest.java`. Don't copy the Logback-only files: `PrettyLogLayout.java`, `ErrorJsonProvider.java`, `logback-spring.xml`, and the logstash-logback-encoder entry in `pom-snippet.xml`. Never add Logback or logstash-logback-encoder; Log4j2 stays the only backend.

## 1. When this applies
- **Dependencies:** `org.apache.logging.log4j:log4j-core` / `log4j-api`, `log4j-slf4j2-impl` (or the older `log4j-slf4j-impl`), or `spring-boot-starter-log4j2`, usually together with an exclusion of `spring-boot-starter-logging`.
- **Config:** `log4j2.xml`, `log4j2-spring.xml`, `log4j2.yaml`/`.yml`, `log4j2.json`, `log4j2.properties`, `log4j2-test.xml`, or `-Dlog4j2.configurationFile`. **Code:** `LogManager.getLogger`, Lombok `@Log4j2`, `ThreadContext`.
- **Add:** `org.apache.logging.log4j:log4j-layout-template-json`, same version as `log4j-core` (Spring Boot manages it). Log4j 2.20 or later is assumed.

## 2. correlationId: MDC becomes ThreadContext
Copy the sample's three correlation files. Only these edits are needed:
- `CorrelationId.java`: `import org.slf4j.MDC;` becomes `import org.apache.logging.log4j.ThreadContext;`, and `MDC.get(MDC_KEY)` becomes `ThreadContext.get(MDC_KEY)`.
- `CorrelationIdFilter.java`: `MDC.put` / `MDC.remove` become `ThreadContext.put` / `ThreadContext.remove`. Nothing else changes, because the `TaggedLogger` below keeps the sample's API (`of`, `ctx`, `info(tags, msg, ctx, durationMs)`).
- `CorrelationPropagation.java`: unchanged. It only calls `CorrelationId.current()`.

With `log4j-slf4j2-impl`, SLF4J `MDC` is already backed by `ThreadContext`, so unconverted code still works. Convert anyway, so the logging package depends only on `log4j-api`.

**Jobs and listeners:** `try (var c = CloseableThreadContext.put(CorrelationId.MDC_KEY, CorrelationId.resolve(headerOrNull))) { ... }`.
**Executors:** use a `TaskDecorator`: `var m = ThreadContext.getImmutableContext(); return () -> { ThreadContext.putAll(m); try { r.run(); } finally { ThreadContext.clearMap(); } };`.

## 3. JSON output: JsonTemplateLayout plus one custom resolver
The built-in resolvers can't produce lowercase `debug|info|warn|error`, the `"none"` / `["legacy"]` defaults, or the fields carried on the wrapper's message. A single `codekit` resolver does all of these. Add `LogFields.java` and `CodekitResolverFactory.java` to the logging package:
```java
final class LogFields {                                   // shared by the JSON resolver and the pretty converter
    static TaggedLogger.TaggedMessage tagged(LogEvent e) { return e.getMessage() instanceof TaggedLogger.TaggedMessage m ? m : null; }
    static List<String> tags(LogEvent e) { var m = tagged(e); return m != null ? m.tags() : List.of("legacy"); }
    static String correlationId(LogEvent e) { String id = e.getContextData().getValue(CorrelationId.MDC_KEY); return id == null || id.isEmpty() ? "none" : id; }
    static String level(Level l) { return l.isMoreSpecificThan(Level.ERROR) ? "error" : l.isMoreSpecificThan(Level.WARN) ? "warn" : l.isMoreSpecificThan(Level.INFO) ? "info" : "debug"; }
    static String stack(Throwable t) { var sw = new StringWriter(); t.printStackTrace(new PrintWriter(sw)); return sw.toString(); } // incl. "Caused by:"
}

@Plugin(name = "CodekitResolverFactory", category = TemplateResolverFactory.CATEGORY)
public final class CodekitResolverFactory implements EventResolverFactory {
    private static final CodekitResolverFactory INSTANCE = new CodekitResolverFactory();
    private CodekitResolverFactory() { }
    @PluginFactory public static CodekitResolverFactory getInstance() { return INSTANCE; }
    @Override public String getName() { return "codekit"; }

    @Override public EventResolver create(EventResolverContext context, TemplateResolverConfig config) {
        String field = config.getString("field");             // level|correlationId|tags|context|durationMs|error
        return new EventResolver() {
            @Override public boolean isResolvable(LogEvent e) {  // false = field omitted from the line (verify)
                var m = LogFields.tagged(e);
                return switch (field) {
                    case "context" -> m != null && m.context() != null;
                    case "durationMs" -> m != null && m.durationMs() != null;
                    case "error" -> e.getThrown() != null;
                    default -> true;
                };
            }
            @Override public void resolve(LogEvent e, JsonWriter w) {
                switch (field) {
                    case "level" -> w.writeString(LogFields.level(e.getLevel()));
                    case "correlationId" -> w.writeString(LogFields.correlationId(e));
                    case "tags" -> w.writeValue(LogFields.tags(e));
                    case "context" -> w.writeValue(LogFields.tagged(e).context());
                    case "durationMs" -> w.writeNumber(LogFields.tagged(e).durationMs());
                    case "error" -> { Throwable t = e.getThrown(); w.writeObjectStart();
                        w.writeObjectKey("type"); w.writeString(t.getClass().getName()); w.writeSeparator();
                        w.writeObjectKey("message"); w.writeValue(t.getMessage()); w.writeSeparator();
                        w.writeObjectKey("stack"); w.writeString(LogFields.stack(t)); w.writeObjectEnd(); }
                    default -> throw new IllegalArgumentException("unknown codekit field: " + field);
                }
            }
        };
    }
}
```
The imports come from `org.apache.logging.log4j.layout.template.json.resolver.*` (`EventResolver`, `EventResolverFactory`, `EventResolverContext`, `TemplateResolverConfig`, `TemplateResolverFactory`) and `...layout.template.json.util.JsonWriter`.

**The plugins need the annotation processor.** `log4j-core`'s `PluginProcessor` writes `Log4j2Plugins.dat` at compile time. JDK 23 and later turn implicit processing off, so register it explicitly. For Maven, add `<path><groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId><version>${log4j2.version}</version></path>` to `maven-compiler-plugin` `<annotationProcessorPaths>`, and list Lombok there too if the project uses it. For Gradle, use `annotationProcessor "org.apache.logging.log4j:log4j-core"` (verify against the project's build).

`src/main/resources/CodekitLayout.json`:
```json
{
  "timestamp": {"$resolver": "timestamp", "pattern": {"format": "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "timeZone": "UTC"}},
  "level": {"$resolver": "codekit", "field": "level"},
  "logger": {"$resolver": "logger", "field": "name"},
  "correlationId": {"$resolver": "codekit", "field": "correlationId"},
  "tags": {"$resolver": "codekit", "field": "tags"},
  "message": {"$resolver": "message", "stringified": true},
  "context": {"$resolver": "codekit", "field": "context"},
  "durationMs": {"$resolver": "codekit", "field": "durationMs"},
  "error": {"$resolver": "codekit", "field": "error"}
}
```
`log4j2-spring.xml` below needs Spring Boot 3 for `<SpringProfile>` and the `spring:` lookup. Without Spring, keep two config files and select one with `-Dlog4j2.configurationFile`. Merge it into the existing config: keep the other appenders and logger levels, and replace only the console layout.
```xml
<Configuration status="WARN">
  <Properties><Property name="SERVICE">${spring:spring.application.name:-unknown-service}</Property></Properties>
  <Appenders>
    <SpringProfile name="prod">
      <Console name="CONSOLE" target="SYSTEM_OUT">
        <JsonTemplateLayout eventTemplateUri="classpath:CodekitLayout.json">
          <EventTemplateAdditionalField key="service" value="${SERVICE}"/>
        </JsonTemplateLayout>
      </Console>
    </SpringProfile>
    <SpringProfile name="!prod">
      <Console name="CONSOLE" target="SYSTEM_OUT"><PatternLayout pattern="%d{HH:mm:ss.SSS} %codekit%n"/></Console>
    </SpringProfile>
  </Appenders>
  <Loggers><Root level="info"><AppenderRef ref="CONSOLE"/></Root></Loggers>
</Configuration>
```

## 4. Dev pretty line: a `%codekit` pattern converter
```java
@Plugin(name = "CodekitPrettyConverter", category = PatternConverter.CATEGORY)
@ConverterKeys({"codekit"})
public final class CodekitPrettyConverter extends LogEventPatternConverter {
    private CodekitPrettyConverter() { super("codekit", "codekit"); }
    public static CodekitPrettyConverter newInstance(String[] options) { return new CodekitPrettyConverter(); }

    @Override public void format(LogEvent e, StringBuilder sb) {
        String cid = LogFields.correlationId(e);
        var m = LogFields.tagged(e);
        sb.append(String.format("%-5s", LogFields.level(e.getLevel()).toUpperCase(Locale.ROOT)))
          .append(" [cid=").append(cid.length() > 8 ? cid.substring(cid.length() - 8) : cid).append("] [")
          .append(String.join(",", LogFields.tags(e))).append("] ").append(e.getMessage().getFormattedMessage());
        if (m != null && m.context() != null) m.context().forEach((k, v) -> sb.append(' ').append(k).append('=').append(v));
        if (m != null && m.durationMs() != null) sb.append(" (").append(m.durationMs()).append("ms)");
        if (e.getThrown() != null) sb.append(" error=").append(e.getThrown().getClass().getName()).append(": ").append(e.getThrown().getMessage());
    }
}
```
The pattern `%d{HH:mm:ss.SSS} %codekit%n` produces `09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success userId=42 (12ms)`. No converter in the pattern handles throwables, so PatternLayout (`alwaysWriteExceptions`, on by default) appends the stack trace on the following lines. Set `alwaysWriteExceptions="false"` to get the single line only.

## 5. Tagged wrapper over the Log4j API
Keep the public API of the sample's `TaggedLogger.java`. Copy `ctx(...)`, `validateTags(...)` and every `debug/info/warn/error` overload verbatim, but switch them to `org.apache.logging.log4j.Level`. Drop `Field`, `MDC_TAGS` and the MDC handling of tags, because tags now travel on the message. The internals become:
```java
private final org.apache.logging.log4j.Logger delegate;
public static TaggedLogger of(Class<?> type) { return new TaggedLogger(LogManager.getLogger(type)); }

private void log(Level level, List<String> tags, String message, Map<String, ?> context, Long durationMs, Throwable error) {
    validateTags(tags);                                          // fails fast even when the level is disabled
    Objects.requireNonNull(message, "message");
    if (!delegate.isEnabled(level)) return;
    Map<String, Object> ctx = context == null || context.isEmpty() ? null : new LinkedHashMap<>(context);
    delegate.log(level, new TaggedMessage(message, List.copyOf(tags), ctx, durationMs), error);
}

/** Literal text (no {} parsing). Fields are read by CodekitResolverFactory and CodekitPrettyConverter. */
public record TaggedMessage(String text, List<String> tags, Map<String, Object> context, Long durationMs)
        implements org.apache.logging.log4j.message.Message {
    @Override public String getFormattedMessage() { return text; }  @Override public String getFormat() { return text; }
    @Override public Object[] getParameters() { return null; }       @Override public Throwable getThrowable() { return null; }
}
```
With async loggers (`AsyncLoggerContextSelector`), a non-reusable `Message` is passed by reference, so the resolver still sees a `TaggedMessage` (verify on the project's setup).

## 6. Legacy calls get the tag `legacy`
`LogFields.tags()` returns `["legacy"]` for any event whose message isn't a `TaggedMessage`. That covers `LogManager.getLogger(...).info("x {}", y)`, `@Log4j2`, SLF4J calls through `log4j-slf4j2-impl`, and framework logs. These entries still carry `timestamp/level/service/logger/correlationId/message/error`. Don't rewrite them in bulk. Convert a call to `TaggedLogger` when the AI touches that code.

## 7. Ban raw logging, with the existing calls frozen
In `LoggingArchitectureTest.java`, keep `no_standard_streams` and wrap the logger rule in `FreezingArchRule`, so that only new violations fail:
```java
@ArchTest
static final ArchRule no_raw_loggers = FreezingArchRule.freeze(noClasses()
        .that().resideOutsideOfPackage("com.example.logging..")
        .should().dependOnClassesThat().haveFullyQualifiedName("org.apache.logging.log4j.LogManager")   // also @Log4j2
        .orShould().dependOnClassesThat().haveFullyQualifiedName("org.slf4j.LoggerFactory")            // also @Slf4j
        .because("new code logs through TaggedLogger so every entry carries tags")
        .allowEmptyShould(true));
```
In `src/test/resources/archunit.properties`, set `freeze.store.default.allowStoreCreation=true` and `freeze.store.default.path=src/test/resources/archunit_store`, then commit the store. Fixed violations leave the store; new ones fail the build.

## 8. Checklist
```bash
curl -si localhost:8080/actuator/health | grep -i x-correlation-id                                     # generated (trace id / UUIDv7)
curl -si -H 'X-Correlation-Id: cid-check-123' localhost:8080/actuator/health | grep -i x-correlation-id  # echoed
SPRING_PROFILES_ACTIVE=prod java -jar target/app.jar > app.log    # then repeat both curls
grep '"correlationId":"cid-check-123"' app.log                     # Request in + Request out (+ app lines)
jq -c 'select((.tags|length)==0 or (.level|test("^(debug|info|warn|error)$")|not))' app.log   # must print nothing
grep -m3 '"tags":\["legacy"\]' app.log; grep -m1 '"correlationId":"none"' app.log            # untagged / startup lines
```
- [ ] Each line is one JSON object. `timestamp` is UTC with `.SSS`, and an exception produces `error.type/message/stack`, with the stack including `Caused by:`.
- [ ] Without the `prod` profile, lines match `09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success userId=42 (12ms)`.
- [ ] The downstream service (or WireMock) receives the same `X-Correlation-Id`. A new `LogManager.getLogger(...)` fails `LoggingArchitectureTest`.
- [ ] `target/classes/META-INF/org/apache/logging/log4j/core/config/plugins/Log4j2Plugins.dat` exists. Without it, `codekit` and `%codekit` are not found.
