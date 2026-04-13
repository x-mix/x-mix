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

  return {
    rpcUrl,
    programId,
    relayerKeypairPath,
    feeCollector,
    requestsPath,
    processedRequestsPath,
    failedRequestsPath,
    pollIntervalMs: parseNumber(process.env.POLL_INTERVAL_MS, 15_000),
    maxSignatureScan: parseNumber(process.env.MAX_SIGNATURE_SCAN, 200),
    maxKnownSignatures: parseNumber(process.env.MAX_KNOWN_SIGNATURES, 5_000),
    maxRelayRetries: parseNumber(process.env.MAX_RELAY_RETRIES, 3),
    dryRun: parseBoolean(process.env.DRY_RUN, true),
    statePath,
  };
}
