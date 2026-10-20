package io.soroban.explorer.pagination;

import java.util.HashMap;
import java.util.Map;

/**
 * Common pagination query parameters.
 */
public record PaginationParams(
    String cursor,
    Integer limit,
    Integer page,
    Integer offset
) {
    public static PaginationParams cursor(String cursor, Integer limit) {
        return new PaginationParams(cursor, limit, null, null);
    }

    public static PaginationParams offset(Integer page, Integer limit) {
        return new PaginationParams(null, limit, page, null);
    }

    public Map<String, Object> toMap() {
        Map<String, Object> map = new HashMap<>();
        if (cursor != null) map.put("cursor", cursor);
        if (limit != null) map.put("limit", limit);
        if (page != null) map.put("page", page);
        if (offset != null) map.put("offset", offset);
        return map;
    }
}
