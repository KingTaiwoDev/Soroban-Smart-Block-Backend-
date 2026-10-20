package io.soroban.explorer.pagination;

import java.util.Collections;
import java.util.List;
import java.util.Optional;

/**
 * Represents a paginated list of items returned by the Soroban Explorer API.
 */
public record Page<T>(
    List<T> items,
    String cursor,
    String nextCursor,
    Long total,
    boolean hasNext
) {
    public Page {
        items = items != null ? Collections.unmodifiableList(items) : List.of();
    }

    public static <T> Page<T> of(List<T> items, String nextCursor, Long total) {
        boolean hasNext = nextCursor != null && !nextCursor.isBlank();
        return new Page<>(items, null, nextCursor, total, hasNext);
    }

    public Optional<String> getNextCursor() {
        return Optional.ofNullable(nextCursor);
    }
}
