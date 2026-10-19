import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { metrics as otelMetrics } from '@opentelemetry/api';

export const registry = new Registry();
const gasFeeAlertMeter = otelMetrics.getMeter('soroban-gas-fee-alerts');

// Collect default Node.js metrics (CPU, memory, event loop, etc.)
collectDefaultMetrics({ register: registry });

// ── API latency ──────────────────────────────────────────────────────────────
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const httpRequestTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
});

export const apiSloRequestsTotal = new Counter({
  name: 'api_slo_requests_total',
  help: 'API requests by bounded endpoint class and SLO outcome',
  labelNames: ['endpoint_class', 'outcome'],
  registers: [registry],
});

export const apiSloRequestDuration = new Histogram({
  name: 'api_slo_request_duration_seconds',
  help: 'API request duration by bounded endpoint class and SLO outcome',
  labelNames: ['endpoint_class', 'outcome'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2.5, 5, 10],
  registers: [registry],
});

// ── HTTP Errors (global error handler) ───────────────────────────────────────
export const httpErrorsTotal = new Counter({
  name: 'http_errors_total',
  help: 'Total number of HTTP errors by classification code',
  labelNames: ['code', 'severity', 'route'],
  registers: [registry],
});

export const contractAbiSubmissionOperations = new Counter({
  name: 'contract_abi_submission_operations_total',
  help: 'Contract ABI submission workflow operations by operation and outcome',
  labelNames: ['operation', 'outcome'],
  registers: [registry],
});

export const gasFeeAlertApiOperations = new Counter({
  name: 'gas_fee_alert_api_operations_total',
  help: 'Gas fee alert API operations by operation and outcome',
  labelNames: ['operation', 'outcome'],
  registers: [registry],
});
export const gasFeeAlertApiOperationsOtel = gasFeeAlertMeter.createCounter(
  'gas.fee_alert.api.operations',
);
export const gasFeeAlertOutboxOperations = new Counter({
  name: 'gas_fee_alert_outbox_operations_total',
  help: 'Gas fee alert outbox enqueue outcomes',
  labelNames: ['outcome'],
  registers: [registry],
});
export const gasFeeAlertOutboxOperationsOtel = gasFeeAlertMeter.createCounter(
  'gas.fee_alert.outbox.operations',
);
export const gasFeeAlertDeliveryOperations = new Counter({
  name: 'gas_fee_alert_delivery_operations_total',
  help: 'Gas fee alert event delivery enqueue outcomes',
  labelNames: ['outcome'],
  registers: [registry],
});
export const gasFeeAlertDeliveryOperationsOtel = gasFeeAlertMeter.createCounter(
  'gas.fee_alert.delivery.operations',
);
export const gasFeeAlertEvaluatorOperations = new Counter({
  name: 'gas_fee_alert_evaluator_operations_total',
  help: 'Gas fee alert snapshot evaluation outcomes',
  labelNames: ['outcome'],
  registers: [registry],
});
export const gasFeeAlertEvaluatorOperationsOtel = gasFeeAlertMeter.createCounter(
  'gas.fee_alert.evaluator.operations',
);
export const gasFeeAlertDeliveryAttempts = new Counter({
  name: 'gas_fee_alert_delivery_attempts_total',
  help: 'Gas fee alert webhook attempts by bounded outcome',
  labelNames: ['outcome'],
  registers: [registry],
});
export const gasFeeAlertDeliveryAttemptsOtel = gasFeeAlertMeter.createCounter(
  'gas.fee_alert.delivery.attempts',
);
export const gasFeeAlertEventToDeliverySeconds = new Histogram({
  name: 'gas_fee_alert_event_to_delivery_seconds',
  help: 'Elapsed time from completed fee-bucket end to successful gas alert webhook delivery',
  buckets: [0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
  registers: [registry],
});
export const gasFeeAlertEventToDeliveryOtel = gasFeeAlertMeter.createHistogram(
  'gas.fee_alert.event_to_delivery',
  { unit: 's' },
);

export const contractAbiSubmissionValidationDuration = new Histogram({
  name: 'contract_abi_submission_validation_duration_seconds',
  help: 'Time to validate submitted ABI functions against indexed contract activity',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

// ── Webhook batch delivery ───────────────────────────────────────────────────
export const webhookBatchOperationsTotal = new Counter({
  name: 'webhook_batch_operations_total',
  help: 'Webhook batch queue and delivery outcomes',
  labelNames: ['operation', 'outcome'],
  registers: [registry],
});

export const webhookBatchEvents = new Histogram({
  name: 'webhook_batch_events',
  help: 'Number of events in a dispatched webhook batch',
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500],
  registers: [registry],
});

export const webhookDeliveryDurationSeconds = new Histogram({
  name: 'webhook_delivery_duration_seconds',
  help: 'Webhook destination request duration in seconds by delivery mode',
  labelNames: ['mode'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const webhookEventToDeliverySeconds = new Histogram({
  name: 'webhook_event_to_delivery_seconds',
  help: 'Elapsed time from event ledger close to successful webhook delivery',
  labelNames: ['mode'],
  buckets: [0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

const webhookMeter = otelMetrics.getMeter('soroban-webhook-delivery');
export const webhookBatchOperationsOtel = webhookMeter.createCounter('webhook.batch.operations');
export const webhookBatchEventsOtel = webhookMeter.createHistogram('webhook.batch.events');
export const webhookDeliveryDurationOtel = webhookMeter.createHistogram(
  'webhook.delivery.duration',
  { unit: 's' },
);
export const webhookEventToDeliveryOtel = webhookMeter.createHistogram(
  'webhook.event_to_delivery',
  { unit: 's' },
);
let webhookOutboxDepthValue = 0;
export const webhookOutboxDepth = new Gauge({
  name: 'webhook_outbox_events',
  help: 'Pending or in-flight durable webhook outbox events',
  registers: [registry],
});
webhookMeter
  .createObservableGauge('webhook.outbox.events')
  .addCallback((observable) => observable.observe(webhookOutboxDepthValue));

export function setWebhookOutboxDepth(value: number): void {
  webhookOutboxDepthValue = Math.max(0, value);
  webhookOutboxDepth.set(webhookOutboxDepthValue);
}

// ── 5xx Error Surge Alerting ─────────────────────────────────────────────────
export const http5xxSurge = new Gauge({
  name: 'http_5xx_surge_ratio',
  help: 'Ratio of 5xx errors to total requests over 5min window (>0.01 triggers alert)',
  registers: [registry],
});

// ── Indexer / ingestion ──────────────────────────────────────────────────────
export const indexerLastLedger = new Gauge({
  name: 'indexer_last_ledger',
  help: 'Last ledger sequence number processed by the indexer',
  labelNames: ['network'],
  registers: [registry],
});

export const indexerIngestionLag = new Gauge({
  name: 'indexer_ingestion_lag_ledgers',
  help: 'Number of ledgers behind the chain tip',
  labelNames: ['network'],
  registers: [registry],
});

export const indexerLedgerCloseTimestamp = new Gauge({
  name: 'indexer_ledger_close_timestamp_seconds',
  help: 'Unix timestamp of the latest successfully indexed ledger close time',
  labelNames: ['network'],
  registers: [registry],
});

export function setIndexerProgress(network: string, lastLedger: number, chainTip: number): void {
  indexerLastLedger.set({ network }, lastLedger);
  indexerIngestionLag.set({ network }, Math.max(0, chainTip - lastLedger));
}

export const indexerLedgersProcessed = new Counter({
  name: 'indexer_ledgers_processed_total',
  help: 'Total number of ledgers processed',
  registers: [registry],
});

export const indexerProcessingDuration = new Histogram({
  name: 'indexer_ledger_processing_duration_seconds',
  help: 'Time to process a batch of ledgers',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const indexerErrors = new Counter({
  name: 'indexer_errors_total',
  help: 'Total number of indexer errors',
  labelNames: ['type'],
  registers: [registry],
});

export const indexerPipelineStageDuration = new Histogram({
  name: 'indexer_pipeline_stage_duration_seconds',
  help: 'Latency duration of individual indexer pipeline stages',
  labelNames: ['stage'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const indexerPipelineStageLag = new Gauge({
  name: 'indexer_pipeline_stage_lag_ledgers',
  help: 'Ledger distance lag for each indexer pipeline stage',
  labelNames: ['network', 'stage'],
  registers: [registry],
});

export const indexerPipelineStageProcessedTotal = new Counter({
  name: 'indexer_pipeline_stage_processed_total',
  help: 'Total processed items/events per indexer pipeline stage',
  labelNames: ['stage', 'status'],
  registers: [registry],
});

// ── Database health ──────────────────────────────────────────────────────────
export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [registry],
});

export const dbConnectionStatus = new Gauge({
  name: 'db_connection_status',
  help: 'Database connection status (1 = healthy, 0 = unhealthy)',
  registers: [registry],
});

// ── Cache health ─────────────────────────────────────────────────────────────
export const cacheBackendStatus = new Gauge({
  name: 'cache_backend_status',
  help: 'Cache backend in use: 1 = Redis connected, 0 = in-memory fallback',
  registers: [registry],
});

export const redisCacheOperationsTotal = new Counter({
  name: 'redis_cache_operations_total',
  help: 'Redis-backed cache operations by bounded cache family, operation, and outcome',
  labelNames: ['family', 'operation', 'outcome'],
  registers: [registry],
});

// ── Replica lag ──────────────────────────────────────────────────────────────
export const replicaLagCheckErrors = new Counter({
  name: 'replica_lag_check_errors_total',
  help: 'Total number of replica lag-check failures (forces primary selection)',
  registers: [registry],
});

// ── Background job / cron metrics (#911) ─────────────────────────────────────
// Recurring jobs (price updates, audit pipeline, key rotation, aggregation
// snapshots) previously exposed no per-job metrics — job health was only
// visible in logs. These make silently failing jobs detectable and feed the
// worker health check so /health reflects reality.
export const cronJobRunsTotal = new Counter({
  name: 'cron_job_runs_total',
  help: 'Total number of cron job executions by job and outcome',
  labelNames: ['job', 'status'],
  registers: [registry],
});

export const cronJobDurationSeconds = new Histogram({
  name: 'cron_job_duration_seconds',
  help: 'Duration of cron job executions in seconds',
  labelNames: ['job'],
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900],
  registers: [registry],
});

export const cronJobLastSuccessTimestamp = new Gauge({
  name: 'cron_job_last_success_timestamp',
  help: 'Unix timestamp (seconds) of the last successful run of each cron job',
  labelNames: ['job'],
  registers: [registry],
});

// ── Indexer error queue / DLQ (#912) ─────────────────────────────────────────
// Failed ledgers/transactions are retried through the error queue; without
// these, a ledger failing 50 times is indistinguishable from a one-off error.
// Gauges expose queue depth for backpressure decisions; counters expose
// retry activity and permanent (dead-lettered) failures by reason.
export const indexerErrorQueueDepth = new Gauge({
  name: 'indexer_error_queue_depth',
  help: 'Number of items currently in the indexer error queue by queue type',
  labelNames: ['network', 'queue'],
  registers: [registry],
});

export const indexerErrorRetriesTotal = new Counter({
  name: 'indexer_error_retries_total',
  help: 'Total number of retries performed for failed indexer items',
  labelNames: ['network', 'type'],
  registers: [registry],
});

export const indexerErrorDlqTotal = new Counter({
  name: 'indexer_error_dlq_total',
  help: 'Total number of items dead-lettered by network and reason',
  labelNames: ['network', 'reason'],
  registers: [registry],
});

export const indexerErrorDlqOldestAgeSeconds = new Gauge({
  name: 'indexer_error_dlq_oldest_age_seconds',
  help: 'Age in seconds of the oldest item currently in the dead-letter queue',
  labelNames: ['network'],
  registers: [registry],
});

// ── Health probe metrics (#918) ───────────────────────────────────────────────
// Track latency and outcome of /healthz, /readyz, and /health probe endpoints
// so probe traffic is observable and regressions are caught in CI load tests.

export const healthProbeRequestsTotal = new Counter({
  name: 'health_probe_requests_total',
  help: 'Total number of health probe requests by endpoint and status',
  labelNames: ['endpoint', 'status_code'],
  registers: [registry],
});

export const healthProbeDurationSeconds = new Histogram({
  name: 'health_probe_duration_seconds',
  help: 'Duration of health probe responses in seconds by endpoint',
  labelNames: ['endpoint'],
  // Sub-millisecond buckets appropriate for cheap liveness probes.
  // /healthz should be <1ms; /readyz should be <50ms.
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [registry],
});

// OTel mirror of probe counters — feeds OTLP exporters (Grafana Cloud, etc.)
const healthProbeMeter = otelMetrics.getMeter('soroban-health-probes');
export const healthProbeRequestsOtel = healthProbeMeter.createCounter('health.probe.requests', {
  description: 'Total health probe requests by endpoint and outcome',
});
export const healthProbeDurationOtel = healthProbeMeter.createHistogram('health.probe.duration', {
  unit: 's',
  description: 'Health probe response time in seconds',
});
