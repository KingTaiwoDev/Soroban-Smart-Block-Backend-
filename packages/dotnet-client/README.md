# Soroban Explorer .NET SDK Client

Official C# / .NET client library for the **Soroban Smart Block Explorer API**, generated automatically from the OpenAPI specification (`/api/v1/openapi.json`).

## Features

- **Typed Models & Operations**: Strongly typed records for all request and response schemas in the OpenAPI specification.
- **Authentication**: Native support for API keys via the `x-api-key` header.
- **Cursor Pagination**: Fluent `EnumeratePagesAsync<TItem>` async iterator for consuming paginated datasets.
- **Robust Error Handling**: Structured exception hierarchy (`SorobanApiException`, `SorobanAuthenticationException`, `SorobanNotFoundException`, `SorobanValidationException`) with correlation ID tracing.
- **Deterministic Generation**: Generated directly from OpenAPI specs with continuous drift detection in CI.

## Installation

Add the client to your .NET project:

```bash
dotnet add package SorobanExplorer.Client
```

Or via project reference:

```xml
<ItemGroup>
  <ProjectReference Include="path/to/SorobanExplorer.Client.csproj" />
</ItemGroup>
```

## Quickstart

```csharp
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using SorobanExplorer.Client;

var options = new SorobanExplorerClientOptions
{
    BaseUrl = "https://api.soroban-explorer.example/api/v1",
    ApiKey = "your-api-key"
};

using var client = new SorobanExplorerClient(options);

// Call an operation directly
var response = await client.CallAsync<Dictionary<string, object>>("getNetwork");
Console.WriteLine($"Network: {response["network"]}");
```

## Paginated Queries

```csharp
var query = new Dictionary<string, object?> { ["limit"] = 20 };

await foreach (var tx in client.EnumeratePagesAsync<Dictionary<string, object>>("getTransactions", query))
{
    Console.WriteLine($"Tx: {tx["hash"]}");
}
```

## Building & Regenerating

To regenerate models and operations from the backend OpenAPI specification:

```bash
npm run sdk:generate
```

To verify that committed files have not drifted:

```bash
npm run sdk:check
```
