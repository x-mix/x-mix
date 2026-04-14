import fs from 'node:fs/promises';
import path from 'node:path';
import { Logger } from 'pino';
import { getRelayRequestKey } from './deposit-key.js';
import { RelayerConfig, RelayRequest, RelayRequestInput } from './types.js';

function isHexOfLen(value: string, byteLen: number): boolean {
  if (typeof value !== 'string') return false;
  if (value.length !== byteLen * 2) return false;
  return /^[0-9a-fA-F]+$/.test(value);
}

function validateInput(input: RelayRequestInput): string | null {
  if (!input.depositSignature) return 'missing depositSignature';
  if (
    input.depositInstructionIndex !== undefined &&
    (!Number.isInteger(input.depositInstructionIndex) || input.depositInstructionIndex < 0)
  ) {
    return 'invalid depositInstructionIndex';
  }
  if (!input.recipient) return 'missing recipient';
  if (!isHexOfLen(input.nullifierHashHex, 32)) return 'invalid nullifierHashHex';
  if (!isHexOfLen(input.proofAHex, 64)) return 'invalid proofAHex';
  if (!isHexOfLen(input.proofBHex, 128)) return 'invalid proofBHex';
  if (!isHexOfLen(input.proofCHex, 64)) return 'invalid proofCHex';
  if (!Array.isArray(input.publicInputsHex) || input.publicInputsHex.length !== 7) {
    return 'publicInputsHex must contain exactly 7 elements';
  }
  for (const pi of input.publicInputsHex) {
    if (!isHexOfLen(pi, 32)) return 'invalid publicInputsHex element';
  }
  if (!/^\d+$/.test(input.relayerFeeLamports)) return 'invalid relayerFeeLamports';
  if (!/^\d+$/.test(input.recipientAmountLamports)) {
    return 'invalid recipientAmountLamports';
  }
  return null;
}

export async function loadRelayRequests(
  config: RelayerConfig,
  logger: Logger
): Promise<Map<string, RelayRequest>> {
  await fs.mkdir(config.requestsPath, { recursive: true });

  const files = await fs.readdir(config.requestsPath);
  const requests = new Map<string, RelayRequest>();

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    const filePath = path.join(config.requestsPath, file);

    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const input = JSON.parse(raw) as RelayRequestInput;
      const error = validateInput(input);
      if (error) {
        logger.warn({ filePath, error }, 'Invalid relay request file');
        continue;
      }

      const requestId = path.basename(file, '.json');
      requests.set(getRelayRequestKey(input), {
        requestId,
        filePath,
        input,
      });
    } catch (error) {
      logger.warn(
        { filePath, error: error instanceof Error ? error.message : String(error) },
        'Failed to read relay request file'
      );
    }
  }

  return requests;
}

async function moveRequestFile(
  destinationDir: string,
  request: RelayRequest,
  suffix: string
): Promise<void> {
  await fs.mkdir(destinationDir, { recursive: true });
  const fileName = `${request.requestId}.${suffix}.json`;
  const destination = path.join(destinationDir, fileName);
  await fs.rename(request.filePath, destination);
}

export async function markRequestProcessed(
  config: RelayerConfig,
  request: RelayRequest
): Promise<void> {
  await moveRequestFile(config.processedRequestsPath, request, 'processed');
}

export async function markRequestFailed(
  config: RelayerConfig,
  request: RelayRequest
): Promise<void> {
  await moveRequestFile(config.failedRequestsPath, request, 'failed');
}
