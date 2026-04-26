import { buildPoseidon } from 'circomlibjs';
import { Logger } from 'pino';
import { ensureDepositHistory, listPoolDeposits } from './deposit-history.js';
import { RelayerState } from './types.js';

const TREE_LEVELS = 20;
const SNARK_FIELD_SIZE = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

let poseidonInstance: Awaited<ReturnType<typeof buildPoseidon>> | null = null;
let zeroTreePromise: Promise<Uint8Array[]> | null = null;

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
  if (!zeroTreePromise) {
    zeroTreePromise = (async () => {
      const zeros: Uint8Array[] = [new Uint8Array(32)];
      for (let level = 1; level <= TREE_LEVELS; level++) {
        zeros[level] = await hashPoseidon(zeros[level - 1], zeros[level - 1]);
      }
      return zeros;
    })();
  }
  return zeroTreePromise;
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

export async function preparePoolRoots(
  state: RelayerState,
  pool: string,
  pendingCommitmentsHex: string[]
): Promise<{
  pool: string;
  baseCommitmentCount: number;
  pendingCount: number;
  rootsHex: string[];
  latestRootHex: string | null;
  computedRootHex: string | null;
  rootMatches: boolean | null;
  stateUpdatedAt: string;
  lastSeenSlot: number;
}> {
  ensureDepositHistory(state);
  const snapshot = state.poolSnapshots[pool];
  const baseDeposits = listPoolDeposits(state, pool);
  const workingCommitments = baseDeposits.map((d) => hexToBytes(d.commitmentHex));
  const rootsHex: string[] = [];

  for (const commitmentHexRaw of pendingCommitmentsHex) {
    const commitmentHex = commitmentHexRaw.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(commitmentHex)) {
      throw new Error(`invalid commitment hex: ${commitmentHexRaw}`);
    }
    workingCommitments.push(hexToBytes(commitmentHex.toLowerCase()));
    // eslint-disable-next-line no-await-in-loop
    const root = await computeMerkleRoot(workingCommitments);
    rootsHex.push(bytesToHex(root));
  }

  return {
    pool,
    baseCommitmentCount: baseDeposits.length,
    pendingCount: pendingCommitmentsHex.length,
    rootsHex,
    latestRootHex: snapshot?.latestRootHex ?? null,
    computedRootHex: snapshot?.computedRootHex ?? null,
    rootMatches: snapshot?.rootMatches ?? null,
    stateUpdatedAt: state.updatedAt,
    lastSeenSlot: state.lastSeenSlot,
  };
}

export async function rebuildMerkleSnapshots(
  state: RelayerState,
  logger: Logger
): Promise<{ pools: number; matches: number; mismatches: number }> {
  ensureDepositHistory(state);
  const pools = Object.keys(state.poolDepositOrder);

  let matches = 0;
  let mismatches = 0;

  for (const pool of pools) {
    const deposits = listPoolDeposits(state, pool);
    if (deposits.length === 0) continue;
    const commitments = deposits.map((d) => hexToBytes(d.commitmentHex));

    const computedRoot = await computeMerkleRoot(commitments);
    const computedRootHex = bytesToHex(computedRoot);
    const latestOnChainRootHex = deposits[deposits.length - 1].newRootHex;
    const rootMatches = computedRootHex === latestOnChainRootHex;

    const snapshot = state.poolSnapshots[pool] ?? {
      mint: deposits[deposits.length - 1].mint,
      latestRootHex: latestOnChainRootHex,
      commitmentCount: deposits.length,
      lastDepositSignature: deposits[deposits.length - 1].signature,
      updatedAt: new Date().toISOString(),
    };
    snapshot.computedRootHex = computedRootHex;
    snapshot.rootMatches = rootMatches;
    snapshot.latestRootHex = latestOnChainRootHex;
    snapshot.commitmentCount = deposits.length;
    snapshot.lastDepositSignature = deposits[deposits.length - 1].signature;
    snapshot.updatedAt = new Date().toISOString();
    state.poolSnapshots[pool] = snapshot;

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
    pools: pools.length,
    matches,
    mismatches,
  };
}
