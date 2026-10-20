package io.soroban.explorer;

import io.soroban.explorer.errors.ApiExceptions.NotFoundException;
import io.soroban.explorer.errors.RateLimitInfo;
import io.soroban.explorer.pagination.Page;
import io.soroban.explorer.pagination.PaginationParams;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Smoke tests covering successful response parsing, pagination, and standard API error mapping.
 */
public class ClientSmokeTest {

    @Test
    @DisplayName("Smoke Test: Successful response and model pagination")
    void testSuccessfulResponseAndPagination() {
        // Given pagination params
        PaginationParams params = PaginationParams.cursor("cursor_12345", 25);
        Map<String, Object> map = params.toMap();

        assertEquals("cursor_12345", map.get("cursor"));
        assertEquals(25, map.get("limit"));

        // Given a paginated response
        List<String> items = List.of("contract_A", "contract_B");
        Page<String> page = Page.of(items, "cursor_next", 100L);

        assertEquals(2, page.items().size());
        assertTrue(page.hasNext());
        assertEquals("cursor_next", page.nextCursor());
        assertEquals(100L, page.total());
    }

    @Test
    @DisplayName("Smoke Test: Standard API error metadata and 404 mapping")
    void testStandardApiErrorMapping() {
        RateLimitInfo rateLimit = new RateLimitInfo(100, 0, 1700000000L, "free");

        NotFoundException ex = new NotFoundException(
            404,
            "Resource not found",
            "RESOURCE_NOT_FOUND",
            "req_abc123",
            "{\"error\":\"Resource not found\"}",
            rateLimit,
            "getContractsByAddress"
        );

        assertEquals(404, ex.getStatusCode());
        assertEquals("RESOURCE_NOT_FOUND", ex.getCode());
        assertEquals("req_abc123", ex.getRequestId());
        assertEquals("getContractsByAddress", ex.getOperationId());
        assertEquals(0, ex.getRateLimit().remaining());
        assertTrue(ex.getMessage().contains("HTTP 404 [RESOURCE_NOT_FOUND]: Resource not found"));
    }
}
