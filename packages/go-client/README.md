# Soroban Explorer Go Client SDK

First-party Go client library for the Soroban Smart Block Explorer API, automatically generated from `/api/v1/openapi.json`.

## Installation

```bash
go get github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block-Backend-/packages/go-client
```

## Quick Start

```go
package main

import (
	"context"
	"fmt"
	"log"
	"os"

	soroban "github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block-Backend-/packages/go-client"
)

func main() {
	client := soroban.NewClient(
		soroban.WithAPIKey(os.Getenv("SOROBAN_API_KEY")),
	)

	ctx := context.Background()

	// List recent transactions with pagination
	resp, err := client.Transactions.List(ctx, soroban.WithLimit(10))
	if err != nil {
		if soroban.IsRateLimitError(err) {
			log.Fatalf("Rate limit reached: %v", err)
		}
		log.Fatalf("API call failed: %v", err)
	}

	var data struct {
		Transactions []map[string]any `json:"transactions"`
		NextCursor   string           `json:"nextCursor"`
	}
	if err := resp.DecodeJSON(&data); err != nil {
		log.Fatalf("Failed to decode JSON: %v", err)
	}

	fmt.Printf("Fetched %d transactions\n", len(data.Transactions))
}
```

## Features

- **Full OpenAPI Coverage**: Covers all endpoints defined in the OpenAPI contract.
- **Ergonomic Resource Methods**: Named methods for common entities (`Transactions`, `Events`, `Contracts`, `Tokens`, `Wallets`, `Network`).
- **Resilient Retry Logic**: Automatically retries on rate limit (429) and server errors (502/503/504) with exponential backoff and `Retry-After` header parsing.
- **Typed Error Taxonomy**: Categorizes errors into `ValidationError`, `AuthenticationError`, `ForbiddenError`, `NotFoundError`, `RateLimitError`, and `ServerError`.
- **Context Aware**: Full support for `context.Context` timeouts and cancellations.
