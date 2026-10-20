# Deterministic ledger replay

The indexer replay harness accepts fixture ledgers and commits them in ascending
ledger sequence order. Event records are ordered by their stable event ID, and
the resulting SHA-256 digest is computed from a canonical JSON representation.

The harness rejects non-contiguous ledger ranges and duplicate event IDs before
they can advance a replay cursor. Production catch-up checkpoints apply the
same cursor invariant: a completed range must commit its final ledger, and a
cursor cannot pass an absent ledger.

Event persistence IDs are network-scoped and deterministic. A worker retry
therefore reaches the same database `upsert` key and cannot create a second
event row for the same ledger event.
