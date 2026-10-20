package io.soroban.explorer.errors;

/**
 * Exception raised when the API returns a non-2xx HTTP status.
 */
public class ApiException extends SorobanException {
    private final int statusCode;
    private final String code;
    private final String requestId;
    private final String responseBody;
    private final RateLimitInfo rateLimit;
    private final String operationId;

    public ApiException(
        int statusCode,
        String message,
        String code,
        String requestId,
        String responseBody,
        RateLimitInfo rateLimit,
        String operationId
    ) {
        super(formatMessage(statusCode, message, code, requestId));
        this.statusCode = statusCode;
        this.code = code;
        this.requestId = requestId;
        this.responseBody = responseBody;
        this.rateLimit = rateLimit != null ? rateLimit : RateLimitInfo.empty();
        this.operationId = operationId;
    }

    private static String formatMessage(int status, String message, String code, String requestId) {
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP ").append(status);
        if (code != null && !code.isBlank()) {
            sb.append(" [").append(code).append("]");
        }
        sb.append(": ").append(message);
        if (requestId != null && !requestId.isBlank()) {
            sb.append(" (requestId: ").append(requestId).append(")");
        }
        return sb.toString();
    }

    public int getStatusCode() {
        return statusCode;
    }

    public String getCode() {
        return code;
    }

    public String getRequestId() {
        return requestId;
    }

    public String getResponseBody() {
        return responseBody;
    }

    public RateLimitInfo getRateLimit() {
        return rateLimit;
    }

    public String getOperationId() {
        return operationId;
    }
}
