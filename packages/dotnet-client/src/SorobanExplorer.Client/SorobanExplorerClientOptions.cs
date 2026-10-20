namespace SorobanExplorer.Client;

using System;
using System.Net.Http;

/// <summary>
/// Configuration options for SorobanExplorerClient.
/// </summary>
public class SorobanExplorerClientOptions
{
    /// <summary>
    /// Base URL for the explorer backend API.
    /// Default: "https://api.soroban-explorer.example/api/v1"
    /// </summary>
    public string BaseUrl { get; set; } = "https://api.soroban-explorer.example/api/v1";

    /// <summary>
    /// Optional API Key sent in `x-api-key` header for authenticated endpoints.
    /// </summary>
    public string? ApiKey { get; set; }

    /// <summary>
    /// Optional custom HttpClient instance. If not provided, an internal HttpClient is used.
    /// </summary>
    public HttpClient? HttpClient { get; set; }

    /// <summary>
    /// Request timeout (default 30 seconds).
    /// </summary>
    public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Maximum retry attempts for transient HTTP failures.
    /// </summary>
    public int MaxRetries { get; set; } = 3;
}
