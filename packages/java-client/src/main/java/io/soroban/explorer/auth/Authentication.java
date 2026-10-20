package io.soroban.explorer.auth;

import java.net.http.HttpRequest;

/**
 * Authentication strategy interface for Soroban API requests.
 */
public interface Authentication {
    void apply(HttpRequest.Builder requestBuilder);
}
