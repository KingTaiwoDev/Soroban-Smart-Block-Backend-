CREATE TABLE "_ledger_decode_errors" (
  "id" TEXT NOT NULL,
  "network" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "ledger" INTEGER NOT NULL,
  "transaction_hash" TEXT NOT NULL,
  "event_index" INTEGER NOT NULL,
  "error_msg" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP(3),
  CONSTRAINT "_ledger_decode_errors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "_ledger_decode_errors_network_event_id_key"
  ON "_ledger_decode_errors"("network", "event_id");
CREATE INDEX "_ledger_decode_errors_network_ledger_idx"
  ON "_ledger_decode_errors"("network", "ledger");
