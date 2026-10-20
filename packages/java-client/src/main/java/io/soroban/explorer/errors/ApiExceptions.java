package io.soroban.explorer.errors;

/**
 * Concrete exception subclasses representing standard HTTP error codes and client failures.
 */
public final class ApiExceptions {
    private ApiExceptions() {}

    public static class BadRequestException extends ApiException {
        public BadRequestException(int status, String msg, String code, String reqId, String body, RateLimitInfo rl, String opId) {
            super(status, msg, code, reqId, body, rl, opId);
        }
    }

    public static class AuthenticationException extends ApiException {
        public AuthenticationException(int status, String msg, String code, String reqId, String body, RateLimitInfo rl, String opId) {
            super(status, msg, code, reqId, body, rl, opId);
        }
    }

    public static class PermissionDeniedException extends ApiException {
        public PermissionDeniedException(int status, String msg, String code, String reqId, String body, RateLimitInfo rl, String opId) {
            super(status, msg, code, reqId, body, rl, opId);
        }
    }

    public static class NotFoundException extends ApiException {
        public NotFoundException(int status, String msg, String code, String reqId, String body, RateLimitInfo rl, String opId) {
            super(status, msg, code, reqId, body, rl, opId);
        }
    }

    public static class ConflictException extends ApiException {
        public ConflictException(int status, String msg, String code, String reqId, String body, RateLimitInfo rl, String opId) {
            super(status, msg, code, reqId, body, rl, opId);
        }
    }

    public static class UnprocessableException extends ApiException {
        public UnprocessableException(int status, String msg, String code, String reqId, String body, RateLimitInfo rl, String opId) {
            super(status, msg, code, reqId, body, rl, opId);
        }
    }

    public static class RateLimitException extends ApiException {
        private final Double retryAfterSeconds;

        public RateLimitException(int status, String msg, String code, String reqId, String body, RateLimitInfo rl, String opId, Double retryAfterSeconds) {
            super(status, msg, code, reqId, body, rl, opId);
            this.retryAfterSeconds = retryAfterSeconds;
        }

        public Double getRetryAfterSeconds() {
            return retryAfterSeconds;
        }
    }

    public static class ServerException extends ApiException {
        public ServerException(int status, String msg, String code, String reqId, String body, RateLimitInfo rl, String opId) {
            super(status, msg, code, reqId, body, rl, opId);
        }
    }

    public static class NetworkException extends SorobanException {
        public NetworkException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    public static class RequestValidationException extends SorobanException {
        private final String operationId;

        public RequestValidationException(String operationId, String message) {
            super("Validation failed for operation '" + operationId + "': " + message);
            this.operationId = operationId;
        }

        public String getOperationId() {
            return operationId;
        }
    }

    public static ApiException fromResponse(
        int statusCode,
        String message,
        String code,
        String requestId,
        String responseBody,
        RateLimitInfo rateLimit,
        String operationId,
        Double retryAfterSeconds
    ) {
        return switch (statusCode) {
            case 400 -> new BadRequestException(statusCode, message, code, requestId, responseBody, rateLimit, operationId);
            case 401 -> new AuthenticationException(statusCode, message, code, requestId, responseBody, rateLimit, operationId);
            case 403 -> new PermissionDeniedException(statusCode, message, code, requestId, responseBody, rateLimit, operationId);
            case 404 -> new NotFoundException(statusCode, message, code, requestId, responseBody, rateLimit, operationId);
            case 409 -> new ConflictException(statusCode, message, code, requestId, responseBody, rateLimit, operationId);
            case 422 -> new UnprocessableException(statusCode, message, code, requestId, responseBody, rateLimit, operationId);
            case 429 -> new RateLimitException(statusCode, message, code, requestId, responseBody, rateLimit, operationId, retryAfterSeconds);
            default -> statusCode >= 500
                ? new ServerException(statusCode, message, code, requestId, responseBody, rateLimit, operationId)
                : new ApiException(statusCode, message, code, requestId, responseBody, rateLimit, operationId);
        };
    }
}
