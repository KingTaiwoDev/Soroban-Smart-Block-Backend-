package soroban

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	DefaultBaseURL = "https://api.soroban.network/api/v1"
	DefaultTimeout = 30 * time.Second
	DefaultRetries = 3
)

// Response wraps raw HTTP response data with convenient unmarshaling methods.
type Response struct {
	StatusCode int
	Body       []byte
	Headers    http.Header
}

// DecodeJSON unmarshals the response payload into the provided target pointer.
func (r *Response) DecodeJSON(target any) error {
	return json.Unmarshal(r.Body, target)
}

// RequestOptions configures an outgoing API operation call.
type RequestOptions struct {
	PathParams  map[string]string
	QueryParams url.Values
	Body        any
	Headers     http.Header
}

// RequestOption functional modifier.
type RequestOption func(*RequestOptions)

// WithPathParam sets a path template variable (e.g. {hash}).
func WithPathParam(key, value string) RequestOption {
	return func(o *RequestOptions) {
		if o.PathParams == nil {
			o.PathParams = make(map[string]string)
		}
		o.PathParams[key] = value
	}
}

// WithQueryParam appends a query parameter.
func WithQueryParam(key, value string) RequestOption {
	return func(o *RequestOptions) {
		if o.QueryParams == nil {
			o.QueryParams = make(url.Values)
		}
		o.QueryParams.Add(key, value)
	}
}

// WithLimit sets pagination limit.
func WithLimit(limit int) RequestOption {
	return WithQueryParam("limit", fmt.Sprintf("%d", limit))
}

// WithCursor sets pagination cursor.
func WithCursor(cursor string) RequestOption {
	return WithQueryParam("cursor", cursor)
}

// WithBody sets the JSON request body.
func WithBody(body any) RequestOption {
	return func(o *RequestOptions) {
		o.Body = body
	}
}

// WithHeader adds a custom HTTP header.
func WithHeader(key, value string) RequestOption {
	return func(o *RequestOptions) {
		if o.Headers == nil {
			o.Headers = make(http.Header)
		}
		o.Headers.Add(key, value)
	}
}

// Client is the entry point for the Soroban Explorer Go SDK.
type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
	maxRetries int

	// Ergonomic services matching TypeScript/Python SDKs
	Transactions *TransactionsService
	Events       *EventsService
	Contracts    *ContractsService
	Tokens       *TokensService
	Wallets      *WalletsService
	Network      *NetworkService
}

// ClientOption configures the Client.
type ClientOption func(*Client)

// WithBaseURL overrides the default Soroban backend API base URL.
func WithBaseURL(urlStr string) ClientOption {
	return func(c *Client) {
		c.baseURL = strings.TrimRight(urlStr, "/")
	}
}

// WithAPIKey configures the API key for authenticated operations (X-Api-Key).
func WithAPIKey(key string) ClientOption {
	return func(c *Client) {
		c.apiKey = key
	}
}

// WithHTTPClient provides a custom http.Client.
func WithHTTPClient(httpClient *http.Client) ClientOption {
	return func(c *Client) {
		c.httpClient = httpClient
	}
}

// WithMaxRetries sets the number of retry attempts on transient network or 429/5xx errors.
func WithMaxRetries(retries int) ClientOption {
	return func(c *Client) {
		c.maxRetries = retries
	}
}

// NewClient initializes a new Soroban SDK Client.
func NewClient(opts ...ClientOption) *Client {
	c := &Client{
		baseURL:    DefaultBaseURL,
		httpClient: &http.Client{Timeout: DefaultTimeout},
		maxRetries: DefaultRetries,
	}
	for _, opt := range opts {
		opt(c)
	}

	c.Transactions = &TransactionsService{client: c}
	c.Events = &EventsService{client: c}
	c.Contracts = &ContractsService{client: c}
	c.Tokens = &TokensService{client: c}
	c.Wallets = &WalletsService{client: c}
	c.Network = &NetworkService{client: c}

	return c
}

// Call executes an API operation by operationId, applying path templates, query parameters,
// and authentication headers, with automatic retry for rate limits and transient server errors.
func (c *Client) Call(ctx context.Context, operationID string, opts ...RequestOption) (*Response, error) {
	op, ok := Operations[operationID]
	if !ok {
		return nil, &APIError{
			StatusCode: 400,
			Code:       "UNKNOWN_OPERATION",
			Message:    fmt.Sprintf("operation %q is not defined in the OpenAPI spec", operationID),
			Category:   CategoryValidation,
		}
	}

	reqOpts := &RequestOptions{
		PathParams:  make(map[string]string),
		QueryParams: make(url.Values),
		Headers:     make(http.Header),
	}
	for _, opt := range opts {
		opt(reqOpts)
	}

	// Build path by substituting parameters
	finalPath := op.Path
	for param, val := range reqOpts.PathParams {
		finalPath = strings.ReplaceAll(finalPath, "{"+param+"}", url.PathEscape(val))
	}

	rawURL := c.baseURL + finalPath
	if len(reqOpts.QueryParams) > 0 {
		rawURL += "?" + reqOpts.QueryParams.Encode()
	}

	var bodyReader io.Reader
	var bodyBytes []byte
	if reqOpts.Body != nil {
		var err error
		bodyBytes, err = json.Marshal(reqOpts.Body)
		if err != nil {
			return nil, fmt.Errorf("failed to serialize request body: %w", err)
		}
	}

	var lastErr error
	for attempt := 0; attempt <= c.maxRetries; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(100*(1<<attempt)) * time.Millisecond
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(backoff):
			}
		}

		if bodyBytes != nil {
			bodyReader = bytes.NewReader(bodyBytes)
		}

		httpReq, err := http.NewRequestWithContext(ctx, op.Method, rawURL, bodyReader)
		if err != nil {
			return nil, fmt.Errorf("failed to create http request: %w", err)
		}

		// Set headers
		if op.Body != "none" && reqOpts.Body != nil {
			httpReq.Header.Set("Content-Type", op.ContentType)
		}
		if c.apiKey != "" {
			httpReq.Header.Set("X-Api-Key", c.apiKey)
		}
		httpReq.Header.Set("User-Agent", "soroban-sdk-go/1.0.0")

		for k, vals := range reqOpts.Headers {
			for _, v := range vals {
				httpReq.Header.Add(k, v)
			}
		}

		resp, err := c.httpClient.Do(httpReq)
		if err != nil {
			lastErr = err
			continue
		}

		respBytes, err := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return &Response{
				StatusCode: resp.StatusCode,
				Body:       respBytes,
				Headers:    resp.Header,
			}, nil
		}

		apiErr := ErrorFromResponse(resp.StatusCode, respBytes, resp.Header)

		// Retry on 429 or 5xx if retries remain
		if (resp.StatusCode == 429 || resp.StatusCode >= 500) && attempt < c.maxRetries {
			lastErr = apiErr
			if apiErr.RetryAfter != nil && *apiErr.RetryAfter > 0 {
				select {
				case <-ctx.Done():
					return nil, ctx.Err()
				case <-time.After(*apiErr.RetryAfter):
				}
			}
			continue
		}

		return nil, apiErr
	}

	return nil, lastErr
}

// ── Ergonomic Services ────────────────────────────────────────────────────────

type TransactionsService struct{ client *Client }

func (s *TransactionsService) List(ctx context.Context, opts ...RequestOption) (*Response, error) {
	return s.client.Call(ctx, "getTransactions", opts...)
}

func (s *TransactionsService) Get(ctx context.Context, hash string, opts ...RequestOption) (*Response, error) {
	return s.client.Call(ctx, "getTransactionsByHash", append(opts, WithPathParam("hash", hash))...)
}

type EventsService struct{ client *Client }

func (s *EventsService) List(ctx context.Context, opts ...RequestOption) (*Response, error) {
	return s.client.Call(ctx, "getEvents", opts...)
}

func (s *EventsService) Get(ctx context.Context, id string, opts ...RequestOption) (*Response, error) {
	return s.client.Call(ctx, "getEventsById", append(opts, WithPathParam("id", id))...)
}

type ContractsService struct{ client *Client }

func (s *ContractsService) List(ctx context.Context, opts ...RequestOption) (*Response, error) {
	return s.client.Call(ctx, "getContracts", opts...)
}

func (s *ContractsService) Get(ctx context.Context, address string, opts ...RequestOption) (*Response, error) {
	return s.client.Call(ctx, "getContractsByAddress", append(opts, WithPathParam("address", address))...)
}

type TokensService struct{ client *Client }

func (s *TokensService) List(ctx context.Context, opts ...RequestOption) (*Response, error) {
	return s.client.Call(ctx, "getTokens", opts...)
}

func (s *TokensService) Get(ctx context.Context, address string, opts ...RequestOption) (*Response, error) {
	return s.client.Call(ctx, "getTokensByAddress", append(opts, WithPathParam("address", address))...)
}

type WalletsService struct{ client *Client }

func (s *WalletsService) Transactions(ctx context.Context, address string, opts ...RequestOption) (*Response, error) {
	return s.client.Call(ctx, "getWalletsByAddressTransactions", append(opts, WithPathParam("address", address))...)
}

func (s *WalletsService) Events(ctx context.Context, address string, opts ...RequestOption) (*Response, error) {
	return s.client.Call(ctx, "getWalletsByAddressEvents", append(opts, WithPathParam("address", address))...)
}

type NetworkService struct{ client *Client }

func (s *NetworkService) Status(ctx context.Context, opts ...RequestOption) (*Response, error) {
	return s.client.Call(ctx, "getNetwork", opts...)
}
