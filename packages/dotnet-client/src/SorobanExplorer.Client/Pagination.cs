namespace SorobanExplorer.Client;

using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

/// <summary>
/// Cursor pagination details in list responses.
/// </summary>
public record PageCursorInfo
{
    [JsonPropertyName("next_cursor")]
    public string? NextCursor { get; init; }

    [JsonPropertyName("has_more")]
    public bool HasMore { get; init; }

    [JsonPropertyName("total")]
    public long? Total { get; init; }
}

/// <summary>
/// Generic paginated list envelope.
/// </summary>
public record PaginatedListResponse<TItem>
{
    [JsonPropertyName("data")]
    public List<TItem> Data { get; init; } = new();

    [JsonPropertyName("cursor")]
    public string? Cursor { get; init; }

    [JsonPropertyName("has_more")]
    public bool HasMore { get; init; }

    [JsonPropertyName("pagination")]
    public PageCursorInfo? Pagination { get; init; }
}

/// <summary>
/// Helper extensions for paginated API queries.
/// </summary>
public static class PaginationExtensions
{
    /// <summary>
    /// Asynchronously iterates across all pages of a cursor-paginated endpoint.
    /// </summary>
    public static async IAsyncEnumerable<TItem> EnumeratePagesAsync<TItem>(
        this SorobanExplorerClient client,
        string operationId,
        IDictionary<string, object?>? queryParams = null,
        int maxPages = 100,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var currentParams = queryParams != null
            ? new Dictionary<string, object?>(queryParams)
            : new Dictionary<string, object?>();

        string? cursor = currentParams.TryGetValue("cursor", out var c) ? c?.ToString() : null;
        int pagesFetched = 0;

        while (pagesFetched < maxPages && !cancellationToken.IsCancellationRequested)
        {
            if (!string.IsNullOrEmpty(cursor))
            {
                currentParams["cursor"] = cursor;
            }

            var page = await client.CallAsync<PaginatedListResponse<TItem>>(
                operationId,
                queryParams: currentParams,
                cancellationToken: cancellationToken).ConfigureAwait(false);

            if (page?.Data != null)
            {
                foreach (var item in page.Data)
                {
                    yield return item;
                }
            }

            pagesFetched++;

            // Extract next cursor from root cursor field or pagination metadata
            string? nextCursor = page?.Cursor ?? page?.Pagination?.NextCursor;
            bool hasMore = page?.HasMore == true || page?.Pagination?.HasMore == true;

            if (page == null || !hasMore || string.IsNullOrEmpty(nextCursor) || nextCursor == cursor)
            {
                break;
            }

            cursor = nextCursor;
        }
    }
}
