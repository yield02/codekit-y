# Java / Spring Boot 3 logging sample

Reference implementation of the codekit logging convention for Spring Boot 3.x (Java 17+, `jakarta.*`, SLF4J 2, Logback 1.4/1.5, logstash-logback-encoder 7.4/8.1, ArchUnit 1.x).

> **For AI agents:** copy these files into the target project, then rename the package `com.example.logging` (and, if the project has naming conventions for them, the classes) to match it. Update every place that names the package as a string: `logback-spring.xml` (`PrettyLogLayout`, `ErrorJsonProvider`, the `com.example` logger), and the `packages` / `resideOutsideOfPackage` values in `LoggingArchitectureTest`. Keep the field names, the MDC keys and the `X-Correlation-Id` header exactly as they are: they are part of the cross-stack convention.

## Convention recap

Every entry has `timestamp` (ISO-8601 UTC), `level`, `service`, `correlationId`, `tags` (non-empty string array) and `message`. It can also have `context` (an object), `durationMs` and `error` (`{type, message, stack}`).

Production output (`prod` profile), one JSON object per line:

```json
{"timestamp":"2026-10-25T09:12:03.120Z","message":"Login success","logger":"com.acme.auth.AuthService","thread":"http-nio-8080-exec-1","level":"INFO","service":"auth-api","correlationId":"0192c3a4-5b6d-7e8f-9a0b-1c2d7f3a91c2","tags":["auth","login"],"context":{"userId":42},"durationMs":12}
```

Development output (any other profile):

```
09:12:03.120 INFO  [cid=7f3a91c2] [auth,login] Login success userId=42 (12ms)
```

## Files

| File | Purpose |
|---|---|
| `src/main/java/.../TaggedLogger.java` | The only logging API. `TaggedLogger.of(Class)`, then `debug`/`info`/`warn(tags, message[, context[, durationMs]])` and `error(tags, message, throwable[, context])`. Null or empty tags throw `IllegalArgumentException`, even when the level is disabled. `TaggedLogger.ctx(k, v, ...)` builds an ordered context map. |
| `src/main/java/.../CorrelationId.java` | Header name (`X-Correlation-Id`), MDC key (`correlationId`), `current()`, `resolve(header)` and a hand-written `uuidV7()`. Resolution order: a valid incoming header, then the trace id of the active OpenTelemetry span, then a new UUIDv7. |
| `src/main/java/.../CorrelationIdFilter.java` | `OncePerRequestFilter`, `@Component`, highest precedence. Puts the id in MDC, returns it in the response header, logs `[http] Request in` / `Request out` with method, path, status and durationMs, and clears MDC in `finally`. |
| `src/main/java/.../CorrelationPropagation.java` | `interceptor()` (a `ClientHttpRequestInterceptor` for RestTemplate and RestClient) and `webClientFilter()` (an `ExchangeFilterFunction` for WebClient). Both add `X-Correlation-Id` to outgoing calls. |
| `src/main/java/.../PrettyLogLayout.java` | Logback `LayoutBase` for the dev single-line format. A plain pattern can't do it because the cid shows only the last 8 characters. |
| `src/main/java/.../ErrorJsonProvider.java` | LogstashEncoder provider that writes exceptions as `"error":{"type","message","stack"}`. It applies to framework logs too. |
| `src/main/resources/logback-spring.xml` | `prod` profile: JSON to stdout. Any other profile: `PrettyLogLayout`. `service` comes from `spring.application.name`. |
| `src/test/java/.../LoggingArchitectureTest.java` | ArchUnit rules. They ban `System.out`/`System.err`/`printStackTrace()`, and any use of `org.slf4j.LoggerFactory` (including Lombok `@Slf4j`) outside the logging package. |
| `pom-snippet.xml` | The dependencies you need. |

### How tags, context and durationMs reach the output

`TaggedLogger` does two things for each call:

1. It puts the tags into MDC key `tags` (comma-joined) for the duration of the call, then restores the previous value.
2. It passes tags, context and durationMs as structured arguments. These are `TaggedLogger.Field`, a subclass of logstash's `ObjectAppendingMarker`, the same type `StructuredArguments.kv(...)` creates.

LogstashEncoder writes the structured arguments as real JSON fields: `tags` as an array, `context` as an object and `durationMs` as a number. The MDC copy of `tags` is excluded from JSON so it doesn't duplicate the array as a string. `PrettyLogLayout` reads the tags from MDC and reads context and durationMs from the event's argument array, so both layouts get their data from the same call.

## Setup

1. Add the dependencies from `pom-snippet.xml`. For Spring Boot 3.0 to 3.2, use logstash-logback-encoder `7.4` instead of `8.1`. Don't use 9.x, which requires Jackson 3 and Spring Boot 4. For Gradle, use the same coordinates; the OTel API can go in `compileOnly`.
2. Copy `src/main/java/...` and `src/main/resources/logback-spring.xml`. If the project already has a Logback config, merge them.
3. Set `spring.application.name`. Run production with `SPRING_PROFILES_ACTIVE=prod`, or rename the `prod` profile in `logback-spring.xml` to match the project's profile.
4. Make sure component scanning covers the logging package, so the filter is registered. For example, the `@SpringBootApplication` class can sit in a parent package.
5. If spring-webflux is not on the classpath, delete `CorrelationPropagation.webClientFilter()`, because it won't compile without it.
6. Register propagation on the HTTP clients:

```java
@Bean
RestClient restClient(RestClient.Builder builder) {
    return builder.requestInterceptor(CorrelationPropagation.interceptor()).build();
}

@Bean
RestTemplate restTemplate(RestTemplateBuilder builder) {
    return builder.additionalInterceptors(CorrelationPropagation.interceptor()).build();
}

@Bean
WebClient webClient(WebClient.Builder builder) {
    return builder.filter(CorrelationPropagation.webClientFilter()).build();
}
```

7. Copy `LoggingArchitectureTest` and set `packages` to the project's root package. Then replace existing `LoggerFactory.getLogger` and `@Slf4j` usages with `TaggedLogger`.

## Example usage

```java
import java.util.List;
import com.example.logging.TaggedLogger;
import static com.example.logging.TaggedLogger.ctx;

@Service
class AuthService {
    private static final TaggedLogger log = TaggedLogger.of(AuthService.class);
    private static final List<String> LOGIN = List.of("auth", "login");

    User login(String email, String password) {
        long start = System.nanoTime();
        try {
            User user = authenticate(email, password);
            log.info(LOGIN, "Login success", ctx("userId", user.id()), (System.nanoTime() - start) / 1_000_000);
            return user;
        } catch (BadCredentialsException e) {
            log.warn(LOGIN, "Login rejected", ctx("reason", "bad_credentials"));
            throw e;
        } catch (RuntimeException e) {
            log.error(LOGIN, "Login failed", e, ctx("emailDomain", email.substring(email.indexOf('@') + 1)));
            throw e;
        }
    }
}
```

Non-HTTP entry points such as message listeners and schedulers must do what the filter does: `MDC.put(CorrelationId.MDC_KEY, CorrelationId.resolve(incomingHeaderOrNull))`, then `MDC.remove(...)` in `finally`.

## Notes and limitations

- **Messages are literal text.** Put variable data in `context` and don't use `{}` placeholders. Never log secrets, tokens or full PII.
- **Framework logs have no tags.** Logs from Spring, Hibernate and other libraries don't go through the wrapper, so they carry no `tags`; the pretty layout shows `[-]` for them. They still get `correlationId`, `service` and `error`.
- **Micrometer Tracing (no OTel Java agent).** The tracing filter runs after this filter, so no span exists yet when the id is resolved. To use the trace id, change the filter order to `Ordered.HIGHEST_PRECEDENCE + 2`. With the OTel Java agent, the span already exists and nothing needs to change.
- **Async work.** MDC is thread-local. `@Async` methods, executors, and async servlet requests don't inherit it unless you add a `TaskDecorator` that copies the MDC context. The same applies to reactive WebClient pipelines, which need Reactor context propagation.
- **Incoming ids are restricted.** An incoming `X-Correlation-Id` is accepted only if it has 1 to 128 characters from `[A-Za-z0-9._:-]`. Otherwise a new id is used, which prevents log injection.

## Debuggable, not noisy
- The HTTP filter/middleware writes one `info` line per request, or `warn` `Slow request` above the threshold (1000 ms by default). `Request started` is `debug` only. Turn off the framework's own request log so requests are not logged twice.
- This sample does **not** yet redact secrets, bound `context` size or collapse repeated errors. Add these rules to the wrapper when adopting it. They are described in `logging/adapters/in-house.md` §4 and the Node/Python samples implement them.
