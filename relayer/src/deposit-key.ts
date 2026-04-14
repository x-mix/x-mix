import { DepositJob, RelayRequestInput } from './types.js';

function normalizeInstructionIndex(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}

export function getDepositRefKey(
  depositSignature: string,
  instructionIndex?: number
): string {
  const normalized = normalizeInstructionIndex(instructionIndex);
  if (normalized === undefined) return depositSignature;
  return `${depositSignature}:${normalized}`;
}

export function getDepositJobKey(job: DepositJob): string {
  const idx = job.deposit?.instructionIndex;
  return getDepositRefKey(job.signature, idx);
}

export function getRelayRequestKey(
  input: Pick<RelayRequestInput, 'depositSignature' | 'depositInstructionIndex'>
): string {
  return getDepositRefKey(input.depositSignature, input.depositInstructionIndex);
}
