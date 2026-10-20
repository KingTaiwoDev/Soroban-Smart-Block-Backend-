/**
 * Read-only end-to-end API smoke example.
 *
 * Run with API_BASE_URL=http://localhost:3000 npx ts-node examples/integration/typescript-e2e.ts
 * Optionally set CONTRACT_ID to also retrieve one registered contract.
 */
const baseUrl = (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const apiKey = process.env.API_KEY;

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status} ${response.statusText}`);
  return response.json();
}

async function main(): Promise<void> {
  const health = await getJson('/api/v1/health');
  const network = await getJson('/api/v1/network');
  const events = await getJson('/api/v1/events?limit=5');

  console.log(JSON.stringify({ health, network, eventCount: Array.isArray(events) ? events.length : undefined }, null, 2));

  const contractId = process.env.CONTRACT_ID;
  if (contractId) {
    const contract = await getJson(`/api/v1/contracts/${encodeURIComponent(contractId)}`);
    console.log(JSON.stringify({ contract }, null, 2));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
