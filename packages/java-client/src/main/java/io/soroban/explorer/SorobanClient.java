package io.soroban.explorer;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import io.soroban.explorer.auth.ApiKeyAuth;
import io.soroban.explorer.auth.Authentication;
import io.soroban.explorer.auth.BearerAuth;
import io.soroban.explorer.errors.ApiException;
import io.soroban.explorer.errors.ApiExceptions;
import io.soroban.explorer.errors.RateLimitInfo;
import io.soroban.explorer.pagination.Page;
import io.soroban.explorer.pagination.PaginationParams;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;

/**
 * First-party Java client for the Soroban Smart Contract Block Explorer API.
 */
public final class SorobanClient {
    private final String baseUrl;
    private final Authentication authentication;
    private final HttpClient httpClient;
    private final ObjectMapper objectMapper;
    private final Duration timeout;

    private SorobanClient(Builder builder) {
        this.baseUrl = builder.baseUrl.replaceAll("/+$", "");
        this.authentication = builder.authentication;
        this.httpClient = builder.httpClient != null ? builder.httpClient : HttpClient.newBuilder().build();
        this.objectMapper = builder.objectMapper != null ? builder.objectMapper : defaultObjectMapper();
        this.timeout = builder.timeout != null ? builder.timeout : Duration.ofSeconds(30);
    }

    public static ObjectMapper defaultObjectMapper() {
        return new ObjectMapper()
            .registerModule(new JavaTimeModule())
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
    }

    public static Builder builder() {
        return new Builder();
    }

    public String getBaseUrl() {
        return baseUrl;
    }

    public Optional<Authentication> getAuthentication() {
        return Optional.ofNullable(authentication);
    }

    /**
     * Executes any OpenAPI operation by ID using a typed/parameterized map.
     */
    public <T> T call(String operationId, Map<String, Object> params, Class<T> responseType) {
        return call(operationId, params, new TypeReference<T>() {
            @Override
            public java.lang.reflect.Type getType() {
                return responseType;
            }
        });
    }

    /**
     * Executes any OpenAPI operation by ID returning the deserialized payload.
     */
    public <T> T call(String operationId, Map<String, Object> params, TypeReference<T> responseType) {
        Operations.OperationDef op = Operations.ALL.get(operationId);
        if (op == null) {
            throw new IllegalArgumentException("Unknown operation ID: " + operationId);
        }

        Map<String, Object> safeParams = params != null ? params : Map.of();

        // 1. Substitute path parameters
        String resolvedPath = op.path();
        Set<String> consumed = new HashSet<>();
        for (String pName : op.pathParams()) {
            Object val = safeParams.get(pName);
            if (val == null) {
                throw new ApiExceptions.RequestValidationException(operationId, "Missing required path parameter: " + pName);
            }
            resolvedPath = resolvedPath.replace("{" + pName + "}", URLEncoder.encode(String.valueOf(val), StandardCharsets.UTF_8));
            consumed.add(pName);
        }

        // 2. Query parameters
        StringBuilder query = new StringBuilder();
        for (Operations.QueryParam qp : op.queryParams()) {
            if (safeParams.containsKey(qp.name())) {
                Object val = safeParams.get(qp.name());
                if (val != null) {
                    if (query.length() > 0) query.append('&');
                    query.append(URLEncoder.encode(qp.name(), StandardCharsets.UTF_8))
                         .append('=')
                         .append(URLEncoder.encode(String.valueOf(val), StandardCharsets.UTF_8));
                    consumed.add(qp.name());
                }
            } else if (qp.required()) {
                throw new ApiExceptions.RequestValidationException(operationId, "Missing required query parameter: " + qp.name());
            }
        }

        String fullUrl = baseUrl + resolvedPath + (query.length() > 0 ? "?" + query : "");

        // 3. Body payload
        HttpRequest.BodyPublisher bodyPublisher = HttpRequest.BodyPublishers.noBody();
        if (op.hasBody()) {
            Object bodyObj = safeParams.get("body");
            if (bodyObj == null && op.bodyRequired()) {
                throw new ApiExceptions.RequestValidationException(operationId, "Missing required request body");
            }
            if (bodyObj != null) {
                try {
                    String jsonBody = objectMapper.writeValueAsString(bodyObj);
                    bodyPublisher = HttpRequest.BodyPublishers.ofString(jsonBody, StandardCharsets.UTF_8);
                } catch (Exception e) {
                    throw new ApiExceptions.RequestValidationException(operationId, "Failed to serialize request body: " + e.getMessage());
                }
            }
        }

        // 4. Construct HTTP request
        HttpRequest.Builder reqBuilder = HttpRequest.newBuilder()
            .uri(URI.create(fullUrl))
            .timeout(timeout)
            .method(op.method(), bodyPublisher)
            .header("Accept", "application/json");

        if (op.hasBody()) {
            reqBuilder.header("Content-Type", op.contentType() != null && !op.contentType().isBlank() ? op.contentType() : "application/json");
        }

        if (authentication != null) {
            authentication.apply(reqBuilder);
        }

        // 5. Send request
        HttpResponse<String> response;
        try {
            response = httpClient.send(reqBuilder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            throw new ApiExceptions.NetworkException("HTTP request execution failed: " + e.getMessage(), e);
        }

        // 6. Handle response status & errors
        int status = response.statusCode();
        String body = response.body();

        RateLimitInfo rateLimit = extractRateLimit(response);
        String reqId = response.headers().firstValue("X-Request-ID").orElse(null);

        if (status >= 400) {
            String errorMsg = "Request failed with HTTP status " + status;
            String errorCode = null;
            try {
                JsonNode root = objectMapper.readTree(body);
                if (root.has("message")) errorMsg = root.get("message").asText();
                else if (root.has("error")) errorMsg = root.get("error").asText();
                if (root.has("code")) errorCode = root.get("code").asText();
                if (reqId == null && root.has("requestId")) reqId = root.get("requestId").asText();
            } catch (Exception ignored) {}

            Double retryAfter = response.headers().firstValue("Retry-After")
                .flatMap(s -> {
                    try { return Optional.of(Double.parseDouble(s)); } catch (Exception ex) { return Optional.empty(); }
                }).orElse(null);

            throw ApiExceptions.fromResponse(status, errorMsg, errorCode, reqId, body, rateLimit, operationId, retryAfter);
        }

        if (responseType.getType() == Void.class || responseType.getType() == void.class) {
            return null;
        }

        try {
            return objectMapper.readValue(body, responseType);
        } catch (Exception e) {
            throw new ApiExceptions.RequestValidationException(operationId, "Failed to deserialize response: " + e.getMessage());
        }
    }

    private RateLimitInfo extractRateLimit(HttpResponse<?> resp) {
        Integer limit = resp.headers().firstValue("X-RateLimit-Limit").flatMap(this::parseInt).orElse(null);
        Integer remaining = resp.headers().firstValue("X-RateLimit-Remaining").flatMap(this::parseInt).orElse(null);
        Long reset = resp.headers().firstValue("X-RateLimit-Reset").flatMap(this::parseLong).orElse(null);
        String tier = resp.headers().firstValue("X-RateLimit-Tier").orElse(null);
        return new RateLimitInfo(limit, remaining, reset, tier);
    }

    private Optional<Integer> parseInt(String s) {
        try { return Optional.of(Integer.parseInt(s.trim())); } catch (Exception e) { return Optional.empty(); }
    }

    private Optional<Long> parseLong(String s) {
        try { return Optional.of(Long.parseLong(s.trim())); } catch (Exception e) { return Optional.empty(); }
    }

    // --- Curated Ergonomic Namespaces ---

    public TransactionsNamespace transactions() { return new TransactionsNamespace(); }
    public EventsNamespace events() { return new EventsNamespace(); }
    public ContractsNamespace contracts() { return new ContractsNamespace(); }
    public TokensNamespace tokens() { return new TokensNamespace(); }
    public NetworkNamespace network() { return new NetworkNamespace(); }

    public class TransactionsNamespace {
        public Object list() { return call("getTransactions", Map.of(), Object.class); }
        public Object list(PaginationParams params) { return call("getTransactions", params.toMap(), Object.class); }
        public Object get(String hash) { return call("getTransactionsByHash", Map.of("hash", hash), Object.class); }
    }

    public class EventsNamespace {
        public Object list() { return call("getEvents", Map.of(), Object.class); }
        public Object list(PaginationParams params) { return call("getEvents", params.toMap(), Object.class); }
        public Object get(String id) { return call("getEventsById", Map.of("id", id), Object.class); }
    }

    public class ContractsNamespace {
        public Object list() { return call("getContracts", Map.of(), Object.class); }
        public Object list(PaginationParams params) { return call("getContracts", params.toMap(), Object.class); }
        public Object get(String address) { return call("getContractsByAddress", Map.of("address", address), Object.class); }
    }

    public class TokensNamespace {
        public Object list() { return call("getTokens", Map.of(), Object.class); }
        public Object get(String address) { return call("getTokensByAddress", Map.of("address", address), Object.class); }
    }

    public class NetworkNamespace {
        public Object status() { return call("getNetwork", Map.of(), Object.class); }
    }

    public static final class Builder {
        private String baseUrl = "https://soroban-block-explorer.net/api/v1";
        private Authentication authentication;
        private HttpClient httpClient;
        private ObjectMapper objectMapper;
        private Duration timeout;

        public Builder baseUrl(String baseUrl) {
            this.baseUrl = baseUrl;
            return this;
        }

        public Builder apiKey(String apiKey) {
            this.authentication = new ApiKeyAuth(apiKey);
            return this;
        }

        public Builder bearerToken(String token) {
            this.authentication = new BearerAuth(token);
            return this;
        }

        public Builder authentication(Authentication auth) {
            this.authentication = auth;
            return this;
        }

        public Builder httpClient(HttpClient httpClient) {
            this.httpClient = httpClient;
            return this;
        }

        public Builder objectMapper(ObjectMapper objectMapper) {
            this.objectMapper = objectMapper;
            return this;
        }

        public Builder timeout(Duration timeout) {
            this.timeout = timeout;
            return this;
        }

        public SorobanClient build() {
            return new SorobanClient(this);
        }
    }
}
