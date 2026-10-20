namespace PaginatedQueryExample;

using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using SorobanExplorer.Client;

class Program
{
    static async Task Main(string[] args)
    {
        Console.WriteLine("===================================================================");
        Console.WriteLine("Soroban Explorer C# .NET Client — Paginated Query Example (DX03)");
        Console.WriteLine("===================================================================");

        var options = new SorobanExplorerClientOptions
        {
            BaseUrl = Environment.GetEnvironmentVariable("SOROBAN_API_URL") ?? "https://api.soroban-explorer.example/api/v1",
            ApiKey = Environment.GetEnvironmentVariable("SOROBAN_API_KEY") ?? "dev-preview-key",
            Timeout = TimeSpan.FromSeconds(15)
        };

        using var client = new SorobanExplorerClient(options);

        try
        {
            Console.WriteLine("\n[1] Initiating paginated stream query for recent ledger transactions...");
            var queryParams = new Dictionary<string, object?>
            {
                ["limit"] = 5,
                ["order"] = "desc"
            };

            int totalItems = 0;
            int pageIndex = 1;

            // Iterate asynchronously across multiple cursor-paginated pages
            await foreach (var item in client.EnumeratePagesAsync<Dictionary<string, object>>(
                "getTransactions",
                queryParams,
                maxPages: 3))
            {
                totalItems++;
                string hash = item.TryGetValue("hash", out var h) ? h?.ToString() ?? "N/A" : "N/A";
                string ledger = item.TryGetValue("ledger_sequence", out var l) ? l?.ToString() ?? "0" : "0";
                Console.WriteLine($"  - Tx #{totalItems}: Hash={hash}, Ledger={ledger}");

                if (totalItems % 5 == 0)
                {
                    pageIndex++;
                    Console.WriteLine($"  --- End of Page {pageIndex - 1} ---");
                }
            }

            Console.WriteLine($"\n[Success] Fetched {totalItems} items across paginated queries.");
        }
        catch (SorobanAuthenticationException authEx)
        {
            Console.Error.WriteLine($"\n[Auth Error] Failed to authenticate: {authEx.Message} (HTTP {authEx.StatusCode})");
        }
        catch (SorobanApiException apiEx)
        {
            Console.Error.WriteLine($"\n[API Error] Request failed with code {apiEx.ErrorCode}: {apiEx.Message}");
            if (!string.IsNullOrEmpty(apiEx.CorrelationId))
            {
                Console.Error.WriteLine($"Trace Correlation ID: {apiEx.CorrelationId}");
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"\n[Unexpected Error]: {ex.Message}");
        }
    }
}
