namespace SorobanExplorer.Client;

using System;
using System.Collections.Generic;
using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;

/// <summary>
/// Standard API error payload envelope returned by the backend.
/// </summary>
public record ApiErrorPayload
{
    [JsonPropertyName("error")]
    public string? Error { get; init; }

    [JsonPropertyName("message")]
    public string? Message { get; init; }

    [JsonPropertyName("code")]
    public string? Code { get; init; }

    [JsonPropertyName("statusCode")]
    public int? StatusCode { get; init; }

    [JsonPropertyName("correlationId")]
    public string? CorrelationId { get; init; }

    [JsonPropertyName("details")]
    public JsonElement? Details { get; init; }
}

/// <summary>
/// Base exception thrown when an API request fails with a non-2xx status code.
/// </summary>
public class SorobanApiException : Exception
{
    public HttpStatusCode StatusCode { get; }
    public string? ErrorCode { get; }
    public string? CorrelationId { get; }
    public string? RawResponseBody { get; }
    public ApiErrorPayload? ErrorPayload { get; }

    public SorobanApiException(
        string message,
        HttpStatusCode statusCode,
        string? errorCode = null,
        string? correlationId = null,
        string? rawResponseBody = null,
        ApiErrorPayload? errorPayload = null,
        Exception? innerException = null)
        : base(message, innerException)
    {
        StatusCode = statusCode;
        ErrorCode = errorCode;
        CorrelationId = correlationId;
        RawResponseBody = rawResponseBody;
        ErrorPayload = errorPayload;
    }
}

/// <summary>
/// Thrown when authentication fails (HTTP 401 or 403).
/// </summary>
public class SorobanAuthenticationException : SorobanApiException
{
    public SorobanAuthenticationException(
        string message,
        HttpStatusCode statusCode,
        string? errorCode = null,
        string? correlationId = null,
        string? rawResponseBody = null,
        ApiErrorPayload? errorPayload = null)
        : base(message, statusCode, errorCode, correlationId, rawResponseBody, errorPayload)
    {
    }
}

/// <summary>
/// Thrown when the requested resource does not exist (HTTP 404).
/// </summary>
public class SorobanNotFoundException : SorobanApiException
{
    public SorobanNotFoundException(
        string message,
        HttpStatusCode statusCode,
        string? errorCode = null,
        string? correlationId = null,
        string? rawResponseBody = null,
        ApiErrorPayload? errorPayload = null)
        : base(message, statusCode, errorCode, correlationId, rawResponseBody, errorPayload)
    {
    }
}

/// <summary>
/// Thrown when request parameter or payload validation fails (HTTP 400 or 422).
/// </summary>
public class SorobanValidationException : SorobanApiException
{
    public SorobanValidationException(
        string message,
        HttpStatusCode statusCode,
        string? errorCode = null,
        string? correlationId = null,
        string? rawResponseBody = null,
        ApiErrorPayload? errorPayload = null)
        : base(message, statusCode, errorCode, correlationId, rawResponseBody, errorPayload)
    {
    }
}
