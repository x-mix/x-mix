import { buildPoseidon } from 'circomlibjs';
import { Logger } from 'pino';
import { DepositJob, RelayerState } from './types.js';

const TREE_LEVELS = 20;
const SNARK_FIELD_SIZE = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

let poseidonInstance: Awaited<ReturnType<typeof buildPoseidon>> | null = null;

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const b of bytes) {
    result = (result << 8n) | BigInt(b);
  }
  return result;
}

function bigIntToBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let temp = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(temp & 0xffn);
    temp >>= 8n;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length !== 64) {
    throw new Error(`Invalid 32-byte hex length: ${hex.length}`);
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

async function getPoseidon() {
  if (!poseidonInstance) {
    poseidonInstance = await buildPoseidon();
  }
  return poseidonInstance;
}

async function hashPoseidon(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  const poseidon = await getPoseidon();

  const leftField = bytesToBigInt(left) % SNARK_FIELD_SIZE;
  const rightField = bytesToBigInt(right) % SNARK_FIELD_SIZE;

  const hash = poseidon([leftField, rightField]);
  const asBigInt = BigInt(poseidon.F.toObject(hash));

  return bigIntToBytes(asBigInt);
}

async function buildZeroTree(): Promise<Uint8Array[]> {
  const zeros: Uint8Array[] = [new Uint8Array(32)];
  for (let level = 1; level <= TREE_LEVELS; level++) {
    zeros[level] = await hashPoseidon(zeros[level - 1], zeros[level - 1]);
  }
  return zeros;
}

async function computeMerkleRoot(commitments: Uint8Array[]): Promise<Uint8Array> {
  const zeros = await buildZeroTree();

  if (commitments.length === 0) {
    return zeros[TREE_LEVELS];
  }

  let currentLevel = commitments;

  for (let level = 0; level < TREE_LEVELS; level++) {
    const nextLevel: Uint8Array[] = [];

    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : zeros[level];
      nextLevel.push(await hashPoseidon(left, right));
    }

    currentLevel = nextLevel;
  }

  return currentLevel[0];
}

function sortDepositJobs(jobs: DepositJob[]): DepositJob[] {
  return [...jobs].sort((a, b) => {
    if (a.slot !== b.slot) return a.slot - b.slot;

    const aIdx = a.deposit?.instructionIndex ?? 0;
    const bIdx = b.deposit?.instructionIndex ?? 0;
    if (aIdx !== bIdx) return aIdx - bIdx;

    return a.signature.localeCompare(b.signature);
  });
}

export async function rebuildMerkleSnapshots(
  state: RelayerState,
  logger: Logger
): Promise<{ pools: number; matches: number; mismatches: number }> {
  const byPool = new Map<string, DepositJob[]>();

  for (const job of state.jobs) {
    if (!job.deposit) continue;
    const arr = byPool.get(job.deposit.pool) ?? [];
    arr.push(job);
    byPool.set(job.deposit.pool, arr);
  }

  let matches = 0;
  let mismatches = 0;

  for (const [pool, jobs] of byPool.entries()) {
    const ordered = sortDepositJobs(jobs);
    const commitments = ordered.map((j) => hexToBytes(j.deposit!.commitmentHex));

    const computedRoot = await computeMerkleRoot(commitments);
    const computedRootHex = bytesToHex(computedRoot);
    const latestOnChainRootHex = ordered[ordered.length - 1].deposit!.newRootHex;
    const rootMatches = computedRootHex === latestOnChainRootHex;

    const snapshot = state.poolSnapshots[pool];
    if (snapshot) {
      snapshot.computedRootHex = computedRootHex;
      snapshot.rootMatches = rootMatches;
      snapshot.updatedAt = new Date().toISOString();
    }

    if (rootMatches) {
      matches += 1;
    } else {
      mismatches += 1;
      logger.warn(
        {
          pool,
          latestOnChainRootHex,
          computedRootHex,
          leaves: commitments.length,
        },
        'Merkle root mismatch detected for pool'
      );
    }
  }

  return {
    pools: byPool.size,
    matches,
    mismatches,
  };
}
