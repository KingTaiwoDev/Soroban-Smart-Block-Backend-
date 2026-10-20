package io.soroban.explorer.errors;

/**
 * Rate limit metadata parsed from HTTP response headers.
 */
public record RateLimitInfo(
    Integer limit,
    Integer remaining,
    Long reset,
    String tier
) {
    public static RateLimitInfo empty() {
        return new RateLimitInfo(null, null, null, null);
    }
}
