package io.soroban.explorer.auth;

import java.net.http.HttpRequest;
import java.util.Objects;

/**
 * API Key authentication passing the key via the X-API-Key header.
 */
public final class ApiKeyAuth implements Authentication {
    private final String apiKey;

    public ApiKeyAuth(String apiKey) {
        this.apiKey = Objects.requireNonNull(apiKey, "apiKey must not be null");
    }

    public String getApiKey() {
        return apiKey;
    }

    @Override
    public void apply(HttpRequest.Builder requestBuilder) {
        requestBuilder.header("X-API-Key", apiKey);
    }
}
