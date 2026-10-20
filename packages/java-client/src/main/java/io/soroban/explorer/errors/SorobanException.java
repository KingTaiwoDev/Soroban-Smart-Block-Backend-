package io.soroban.explorer.errors;

/**
 * Base unchecked exception for all errors thrown by the Soroban Explorer client.
 */
public class SorobanException extends RuntimeException {
    public SorobanException(String message) {
        super(message);
    }

    public SorobanException(String message, Throwable cause) {
        super(message, cause);
    }
}
