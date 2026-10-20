package io.soroban.explorer.auth;

import java.net.http.HttpRequest;
import java.util.Objects;

/**
 * Bearer token authentication passing the token via the Authorization header.
 */
public final class BearerAuth implements Authentication {
    private final String token;

    public BearerAuth(String token) {
        this.token = Objects.requireNonNull(token, "token must not be null");
    }

    public String getToken() {
        return token;
    }

    @Override
    public void apply(HttpRequest.Builder requestBuilder) {
        requestBuilder.header("Authorization", "Bearer " + token);
    }
}
