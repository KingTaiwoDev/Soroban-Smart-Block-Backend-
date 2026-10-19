package soroban_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	soroban "github.com/Soroban-Smart-Block-Explorer/Soroban-Smart-Block-Backend-/packages/go-client"
)

func TestClient_OperationCall(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Api-Key") != "test-api-key" {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": "unauthorized",
				"code":  "UNAUTHORIZED",
			})
			return
		}

		if r.URL.Path == "/transactions" {
			if r.URL.Query().Get("limit") != "10" {
				t.Errorf("expected limit=10, got %s", r.URL.Query().Get("limit"))
			}
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"transactions": []map[string]any{
					{"hash": "0x123", "status": "success"},
				},
				"nextCursor": "cursor-xyz",
			})
			return
		}

		if r.URL.Path == "/transactions/0x123" {
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"hash":   "0x123",
				"status": "success",
			})
			return
		}

		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": "not found",
			"code":  "NOT_FOUND",
		})
	}))
	defer server.Close()

	client := soroban.NewClient(
		soroban.WithBaseURL(server.URL),
		soroban.WithAPIKey("test-api-key"),
	)

	ctx := context.Background()

	// Test Transactions.List with pagination options
	resp, err := client.Transactions.List(ctx, soroban.WithLimit(10), soroban.WithCursor("cursor-abc"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	var listData struct {
		Transactions []map[string]any `json:"transactions"`
		NextCursor   string           `json:"nextCursor"`
	}
	if err := resp.DecodeJSON(&listData); err != nil {
		t.Fatalf("failed to decode json: %v", err)
	}
	if len(listData.Transactions) != 1 || listData.NextCursor != "cursor-xyz" {
		t.Errorf("unexpected list response: %+v", listData)
	}

	// Test Transactions.Get with path param
	getResp, err := client.Transactions.Get(ctx, "0x123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if getResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", getResp.StatusCode)
	}
}

func TestClient_ErrorMappingAndRetry(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusTooManyRequests)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error": map[string]any{
					"code":    "RATE_LIMIT_EXCEEDED",
					"message": "Too many requests",
				},
			})
			return
		}

		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
	}))
	defer server.Close()

	client := soroban.NewClient(
		soroban.WithBaseURL(server.URL),
		soroban.WithMaxRetries(2),
	)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	resp, err := client.Call(ctx, "getNetwork")
	if err != nil {
		t.Fatalf("expected retry to succeed, got error: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}
	if attempts != 2 {
		t.Fatalf("expected 2 attempts, got %d", attempts)
	}
}

func TestClient_ValidationError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{
				"code":    "INVALID_PARAM",
				"message": "limit must be positive",
				"details": map[string]any{"field": "limit"},
			},
		})
	}))
	defer server.Close()

	client := soroban.NewClient(soroban.WithBaseURL(server.URL))
	_, err := client.Call(context.Background(), "getTransactions")
	if err == nil {
		t.Fatalf("expected error, got nil")
	}

	if !soroban.IsValidationError(err) {
		t.Fatalf("expected validation error category, got: %v", err)
	}

	apiErr, ok := err.(*soroban.APIError)
	if !ok || apiErr.StatusCode != 400 || apiErr.Code != "INVALID_PARAM" {
		t.Fatalf("expected 400 INVALID_PARAM, got %+v", apiErr)
	}
}
