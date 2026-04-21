import path from 'node:path';
import { RelayerConfig } from './types.js';

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseHost(value: string | undefined, fallback: string): string {
  const host = value?.trim();
  if (!host) return fallback;
  return host;
}

function parseCorsOrigin(value: string | undefined, fallback: string): string {
  const origin = value?.trim();
  if (!origin) return fallback;
  return origin;
}

export function loadConfig(): RelayerConfig {
  const rpcUrl = process.env.RPC_URL?.trim();
  if (!rpcUrl) {
    throw new Error('Missing RPC_URL');
  }

  const programId =
    process.env.PROGRAM_ID?.trim() || 'XmixQ4DB8MtKcEFhyjWs1gZtdaF3YDuF4ieGLJ3xotv';

  const relayerKeypairPath =
    process.env.RELAYER_KEYPAIR?.trim() || '/www/wwwroot/wallets/public/9527.json';

  const feeCollector =
    process.env.FEE_COLLECTOR?.trim() ||
    '4kg8oh3jdNtn7j2wcS7TrUua31AgbLzDVkBZgTAe44aF';

  const statePath = path.resolve(
    process.env.STATE_PATH?.trim() || './relayer-data/state.json'
  );

  const requestsPath = path.resolve(
    process.env.REQUESTS_PATH?.trim() || './relayer-data/requests'
  );

  const processedRequestsPath = path.resolve(
    process.env.PROCESSED_REQUESTS_PATH?.trim() || './relayer-data/processed'
  );

  const failedRequestsPath = path.resolve(
    process.env.FAILED_REQUESTS_PATH?.trim() || './relayer-data/failed'
  );

  const circuitWasmPath = path.resolve(
    process.env.CIRCUIT_WASM_PATH?.trim() || '../circuits/build/transaction_js/transaction.wasm'
  );

  const circuitZkeyPath = path.resolve(
    process.env.CIRCUIT_ZKEY_PATH?.trim() || '../circuits/transaction_0001.zkey'
  );

  return {
    rpcUrl,
    programId,
    relayerKeypairPath,
    feeCollector,
    requestsPath,
    processedRequestsPath,
    failedRequestsPath,
    circuitWasmPath,
    circuitZkeyPath,
    apiEnabled: parseBoolean(process.env.RELAYER_API_ENABLED, true),
    apiHost: parseHost(process.env.RELAYER_API_HOST, '0.0.0.0'),
    apiPort: parseNumber(process.env.RELAYER_API_PORT, 8787),
    apiCorsOrigin: parseCorsOrigin(process.env.RELAYER_API_CORS_ORIGIN, '*'),
    pollIntervalMs: parseNumber(process.env.POLL_INTERVAL_MS, 4_000),
    fallbackPollEveryTicks: parseNumber(process.env.FALLBACK_POLL_EVERY_TICKS, 3),
    logSubscriptionEnabled: parseBoolean(process.env.LOG_SUBSCRIPTION_ENABLED, true),
    maxSignatureScan: parseNumber(process.env.MAX_SIGNATURE_SCAN, 200),
    maxSignatureScanPages: parseNumber(process.env.MAX_SIGNATURE_SCAN_PAGES, 20),
    maxKnownSignatures: parseNumber(process.env.MAX_KNOWN_SIGNATURES, 5_000),
    maxRelayRetries: parseNumber(process.env.MAX_RELAY_RETRIES, 3),
    maxFailedJobsRetained: parseNumber(process.env.MAX_FAILED_JOBS_RETAINED, 200),
    dryRun: parseBoolean(process.env.DRY_RUN, true),
    statePath,
  };
}
