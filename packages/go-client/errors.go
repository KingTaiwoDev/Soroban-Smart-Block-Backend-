package soroban

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// ErrorCategory identifies the high-level semantic class of an API failure.
type ErrorCategory string

const (
	CategoryValidation ErrorCategory = "validation"
	CategoryAuth       ErrorCategory = "auth"
	CategoryForbidden  ErrorCategory = "forbidden"
	CategoryNotFound   ErrorCategory = "not_found"
	CategoryRateLimit  ErrorCategory = "rate_limit"
	CategoryServer     ErrorCategory = "server"
	CategoryUnknown    ErrorCategory = "unknown"
)

// APIError is the structured, typed error returned by the Soroban Go SDK.
type APIError struct {
	StatusCode int           `json:"statusCode"`
	Code       string        `json:"code,omitempty"`
	Message    string        `json:"message"`
	Details    any           `json:"details,omitempty"`
	Category   ErrorCategory `json:"category"`
	RetryAfter *time.Duration `json:"retryAfter,omitempty"`
}

func (e *APIError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("soroban api error (%d %s): %s", e.StatusCode, e.Code, e.Message)
	}
	return fmt.Sprintf("soroban api error (%d): %s", e.StatusCode, e.Message)
}

// Category checkers
func IsValidationError(err error) bool {
	if apiErr, ok := err.(*APIError); ok {
		return apiErr.Category == CategoryValidation
	}
	return false
}

func IsAuthError(err error) bool {
	if apiErr, ok := err.(*APIError); ok {
		return apiErr.Category == CategoryAuth
	}
	return false
}

func IsForbiddenError(err error) bool {
	if apiErr, ok := err.(*APIError); ok {
		return apiErr.Category == CategoryForbidden
	}
	return false
}

func IsNotFoundError(err error) bool {
	if apiErr, ok := err.(*APIError); ok {
		return apiErr.Category == CategoryNotFound
	}
	return false
}

func IsRateLimitError(err error) bool {
	if apiErr, ok := err.(*APIError); ok {
		return apiErr.Category == CategoryRateLimit
	}
	return false
}

func IsServerError(err error) bool {
	if apiErr, ok := err.(*APIError); ok {
		return apiErr.Category == CategoryServer
	}
	return false
}

// ErrorFromResponse maps an HTTP status code, response body, and headers to a typed APIError.
func ErrorFromResponse(statusCode int, body []byte, headers http.Header) *APIError {
	var category ErrorCategory
	switch {
	case statusCode == 400 || statusCode == 422:
		category = CategoryValidation
	case statusCode == 401:
		category = CategoryAuth
	case statusCode == 403:
		category = CategoryForbidden
	case statusCode == 404:
		category = CategoryNotFound
	case statusCode == 429:
		category = CategoryRateLimit
	case statusCode >= 500:
		category = CategoryServer
	default:
		category = CategoryUnknown
	}

	apiErr := &APIError{
		StatusCode: statusCode,
		Category:   category,
		Message:    http.StatusText(statusCode),
	}

	// Parse Retry-After header if present
	if retryAfterHeader := headers.Get("Retry-After"); retryAfterHeader != "" {
		if seconds, err := strconv.Atoi(retryAfterHeader); err == nil && seconds >= 0 {
			duration := time.Duration(seconds) * time.Second
			apiErr.RetryAfter = &duration
		}
	}

	if len(body) > 0 {
		var payload struct {
			Error   any    `json:"error"`
			Message string `json:"message"`
			Code    string `json:"code"`
		}
		if err := json.Unmarshal(body, &payload); err == nil {
			if payload.Message != "" {
				apiErr.Message = payload.Message
			}
			if payload.Code != "" {
				apiErr.Code = payload.Code
			}

			if payload.Error != nil {
				switch v := payload.Error.(type) {
				case string:
					apiErr.Message = v
				case map[string]any:
					if msg, ok := v["message"].(string); ok && msg != "" {
						apiErr.Message = msg
					}
					if code, ok := v["code"].(string); ok && code != "" {
						apiErr.Code = code
					}
					if details, ok := v["details"]; ok {
						apiErr.Details = details
					}
				default:
					apiErr.Details = v
				}
			}
		}
	}

	return apiErr
}
