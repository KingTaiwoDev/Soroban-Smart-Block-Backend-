namespace SorobanExplorer.Client;

using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

/// <summary>
/// Main HTTP client for interacting with the Soroban Explorer Backend API.
/// </summary>
public class SorobanExplorerClient : IDisposable
{
    private readonly HttpClient _httpClient;
    private readonly bool _ownsHttpClient;
    private readonly SorobanExplorerClientOptions _options;
    private readonly JsonSerializerOptions _jsonOptions;

    public SorobanExplorerClient(SorobanExplorerClientOptions? options = null)
    {
        _options = options ?? new SorobanExplorerClientOptions();
        _ownsHttpClient = _options.HttpClient == null;
        _httpClient = _options.HttpClient ?? new HttpClient();

        if (_ownsHttpClient)
        {
            _httpClient.Timeout = _options.Timeout;
        }

        _jsonOptions = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        };
    }

    /// <summary>
    /// Execute an operation by its OpenAPI operationId.
    /// </summary>
    public async Task<TResponse> CallAsync<TResponse>(
        string operationId,
        IDictionary<string, object?>? pathParams = null,
        IDictionary<string, object?>? queryParams = null,
        object? body = null,
        CancellationToken cancellationToken = default)
    {
        if (!Operations.All.TryGetValue(operationId, out var metadata))
        {
            throw new ArgumentException($"Unknown operationId '{operationId}' in specification.", nameof(operationId));
        }

        var uri = BuildUri(metadata, pathParams, queryParams);
        var httpMethod = new HttpMethod(metadata.Method);

        using var request = new HttpRequestMessage(httpMethod, uri);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.Add("User-Agent", "SorobanExplorer-DotNet-Client/1.0.0");

        // Authentication: pass x-api-key if configured
        if (!string.IsNullOrWhiteSpace(_options.ApiKey))
        {
            request.Headers.Add("x-api-key", _options.ApiKey);
        }

        // Body payload
        if (body != null)
        {
            var jsonBody = JsonSerializer.Serialize(body, _jsonOptions);
            request.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");
        }

        HttpResponseMessage response;
        try
        {
            response = await _httpClient.SendAsync(request, cancellationToken).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            throw new SorobanApiException($"HTTP transport error while calling '{operationId}': {ex.Message}", HttpStatusCode.ServiceUnavailable, innerException: ex);
        }

        var responseBody = await response.Content.ReadAsStringAsync().ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            HandleApiError(response.StatusCode, responseBody, operationId);
        }

        if (string.IsNullOrWhiteSpace(responseBody) && typeof(TResponse) == typeof(object))
        {
            return (TResponse)(object)new Dictionary<string, object>();
        }

        try
        {
            var result = JsonSerializer.Deserialize<TResponse>(responseBody, _jsonOptions);
            if (result == null)
            {
                throw new SorobanApiException($"Received empty response deserializing '{operationId}'.", response.StatusCode, rawResponseBody: responseBody);
            }
            return result;
        }
        catch (JsonException ex)
        {
            throw new SorobanApiException($"Failed to deserialize response for '{operationId}': {ex.Message}", response.StatusCode, rawResponseBody: responseBody, innerException: ex);
        }
    }

    private Uri BuildUri(
        OperationMetadata metadata,
        IDictionary<string, object?>? pathParams,
        IDictionary<string, object?>? queryParams)
    {
        string path = metadata.Path;

        if (pathParams != null)
        {
            foreach (var kvp in pathParams)
            {
                if (kvp.Value != null)
                {
                    path = path.Replace($"{{{kvp.Key}}}", Uri.EscapeDataString(kvp.Value.ToString()!));
                }
            }
        }

        var baseUri = new Uri(_options.BaseUrl.TrimEnd('/') + '/' + path.TrimStart('/'));
        var builder = new UriBuilder(baseUri);

        if (queryParams != null && queryParams.Count > 0)
        {
            var query = new StringBuilder();
            bool first = true;
            foreach (var kvp in queryParams)
            {
                if (kvp.Value == null) continue;
                if (!first) query.Append('&');
                query.Append(Uri.EscapeDataString(kvp.Key));
                query.Append('=');
                query.Append(Uri.EscapeDataString(kvp.Value.ToString()!));
                first = false;
            }
            builder.Query = query.ToString();
        }

        return builder.Uri;
    }

    private void HandleApiError(HttpStatusCode statusCode, string responseBody, string operationId)
    {
        ApiErrorPayload? payload = null;
        try
        {
            if (!string.IsNullOrWhiteSpace(responseBody))
            {
                payload = JsonSerializer.Deserialize<ApiErrorPayload>(responseBody, _jsonOptions);
            }
        }
        catch
        {
            // Fallback to raw string if error is not in standard JSON format
        }

        string message = payload?.Message ?? payload?.Error ?? $"API request for '{operationId}' failed with HTTP {(int)statusCode} ({statusCode}).";
        string? errorCode = payload?.Code;
        string? correlationId = payload?.CorrelationId;

        switch (statusCode)
        {
            case HttpStatusCode.Unauthorized:
            case HttpStatusCode.Forbidden:
                throw new SorobanAuthenticationException(message, statusCode, errorCode, correlationId, responseBody, payload);
            case HttpStatusCode.NotFound:
                throw new SorobanNotFoundException(message, statusCode, errorCode, correlationId, responseBody, payload);
            case HttpStatusCode.BadRequest:
            case HttpStatusCode.UnprocessableEntity:
                throw new SorobanValidationException(message, statusCode, errorCode, correlationId, responseBody, payload);
            default:
                throw new SorobanApiException(message, statusCode, errorCode, correlationId, responseBody, payload);
        }
    }

    public void Dispose()
    {
        if (_ownsHttpClient)
        {
            _httpClient.Dispose();
        }
    }
}
