# Soroban Smart Contract Block Explorer - Java Client

First-party, strongly-typed Java client for the Soroban Smart Contract Block Explorer API.

## Package Layout

```
packages/java-client/
├── pom.xml
├── README.md
└── src/
    ├── main/
    │   └── java/
    │       └── io/soroban/explorer/
    │           ├── SorobanClient.java      # Main client entrypoint with builder & ergonomic namespaces
    │           ├── Operations.java         # Generated typed registry of all 380+ OpenAPI operations
    │           ├── auth/
    │           │   ├── Authentication.java # Authentication interface
    │           │   ├── ApiKeyAuth.java     # X-API-Key auth
    │           │   └── BearerAuth.java     # Bearer token auth
    │           ├── errors/
    │           │   ├── SorobanException.java
    │           │   ├── ApiException.java
    │           │   ├── ApiExceptions.java  # BadRequest, NotFound, RateLimit, Server, etc.
    │           │   └── RateLimitInfo.java  # Limit, remaining, reset, tier metadata
    │           ├── models/
    │           │   └── Models.java         # Generated immutable Java records for API schemas
    │           └── pagination/
    │               ├── Page.java           # Typed page container (items, cursor, nextCursor, total)
    │               └── PaginationParams.java
    └── test/
        └── java/
            └── io/soroban/explorer/
                └── ClientSmokeTest.java    # Smoke tests for success, errors, pagination
```

## Maven Dependency

```xml
<dependency>
    <groupId>io.soroban</groupId>
    <artifactId>soroban-block-explorer-client</artifactId>
    <version>1.0.0</version>
</dependency>
```

## Quick Start

```java
import io.soroban.explorer.SorobanClient;
import io.soroban.explorer.pagination.PaginationParams;

public class Main {
    public static void main(String[] args) {
        SorobanClient client = SorobanClient.builder()
            .baseUrl("https://soroban-block-explorer.net/api/v1")
            .apiKey("your-api-key")
            .build();

        // 1. Ergonomic calls
        Object networkStatus = client.network().status();
        Object contracts = client.contracts().list(PaginationParams.cursor(null, 20));

        // 2. Typed direct operation invocation
        Object result = client.call("getContractsByAddress", Map.of("address", "C..."), Object.class);
    }
}
```

## Error Handling

All API errors subclass `ApiException` and provide structured error metadata:

```java
try {
    client.contracts().get("invalid-address");
} catch (ApiExceptions.NotFoundException e) {
    System.err.println("Not found. Code: " + e.getCode() + ", RequestId: " + e.getRequestId());
} catch (ApiExceptions.RateLimitException e) {
    System.err.println("Rate limited. Retry after: " + e.getRetryAfterSeconds());
} catch (ApiException e) {
    System.err.println("API error (" + e.getStatusCode() + "): " + e.getMessage());
}
```
