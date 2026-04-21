import { buildPoseidon } from 'circomlibjs';
import { PublicKey } from '@solana/web3.js';
import { groth16 } from 'snarkjs';
import { DepositJob } from './types.js';

const TREE_LEVELS = 20;
const SNARK_FIELD_SIZE = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

let poseidonInstance: Awaited<ReturnType<typeof buildPoseidon>> | null = null;

async function getPoseidon() {
  if (!poseidonInstance) {
    poseidonInstance = await buildPoseidon();
  }
  return poseidonInstance;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function hexToBytes(hex: string, expectedBytes = 32): Uint8Array {
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('Invalid hex string');
  }
  if (hex.length !== expectedBytes * 2) {
    throw new Error(`Invalid hex length: expected ${expectedBytes * 2}, got ${hex.length}`);
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

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

function toFieldElement(bytes: Uint8Array): bigint {
  return bytesToBigInt(bytes) % SNARK_FIELD_SIZE;
}

async function poseidon2(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  const poseidon = await getPoseidon();
  const hash = poseidon([toFieldElement(left), toFieldElement(right)]);
  const asBigInt = BigInt(poseidon.F.toObject(hash));
  return bigIntToBytes(asBigInt);
}

async function poseidonN(inputs: Uint8Array[]): Promise<Uint8Array> {
  const poseidon = await getPoseidon();
  const hash = poseidon(inputs.map((i) => toFieldElement(i)));
  const asBigInt = BigInt(poseidon.F.toObject(hash));
  return bigIntToBytes(asBigInt);
}

class PoseidonMerkleTree {
  private readonly leaves: Uint8Array[] = [];
  private readonly zeros: Uint8Array[] = [];

  async initialize(): Promise<void> {
    this.zeros[0] = new Uint8Array(32);
    for (let level = 1; level <= TREE_LEVELS; level++) {
      this.zeros[level] = await poseidon2(this.zeros[level - 1], this.zeros[level - 1]);
    }
  }

  insert(leaf: Uint8Array): void {
    this.leaves.push(leaf);
  }

  async root(): Promise<Uint8Array> {
    if (this.leaves.length === 0) {
      return this.zeros[TREE_LEVELS];
    }

    let currentLevel = [...this.leaves];

    for (let level = 0; level < TREE_LEVELS; level++) {
      const nextLevel: Uint8Array[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : this.zeros[level];
        // eslint-disable-next-line no-await-in-loop
        nextLevel.push(await poseidon2(left, right));
      }
      currentLevel = nextLevel;
    }

    return currentLevel[0];
  }

  async getProof(index: number): Promise<{ pathElements: Uint8Array[]; pathIndices: number[] }> {
    if (index < 0 || index >= this.leaves.length) {
      throw new Error(`Leaf index out of range: ${index}`);
    }

    const pathElements: Uint8Array[] = [];
    const pathIndices: number[] = [];

    let currentLevel = [...this.leaves];
    let currentIndex = index;

    for (let level = 0; level < TREE_LEVELS; level++) {
      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;

      const sibling =
        siblingIndex < currentLevel.length ? currentLevel[siblingIndex] : this.zeros[level];

      pathElements.push(sibling);
      pathIndices.push(isLeft ? 0 : 1);

      const nextLevel: Uint8Array[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : this.zeros[level];
        // eslint-disable-next-line no-await-in-loop
        nextLevel.push(await poseidon2(left, right));
      }

      currentLevel = nextLevel;
      currentIndex = Math.floor(currentIndex / 2);
    }

    return { pathElements, pathIndices };
  }
}

function sortDepositJobs(jobs: DepositJob[]): DepositJob[] {
  return [...jobs].sort((a, b) => {
    if (a.slot !== b.slot) return a.slot - b.slot;
    const aTxIndex = Number.isInteger(a.deposit?.txIndex)
      ? (a.deposit?.txIndex as number)
      : Number.MAX_SAFE_INTEGER;
    const bTxIndex = Number.isInteger(b.deposit?.txIndex)
      ? (b.deposit?.txIndex as number)
      : Number.MAX_SAFE_INTEGER;
    if (aTxIndex !== bTxIndex) return aTxIndex - bTxIndex;

    const aIdx = a.deposit?.instructionIndex ?? 0;
    const bIdx = b.deposit?.instructionIndex ?? 0;
    if (aIdx !== bIdx) return aIdx - bIdx;

    return a.signature.localeCompare(b.signature);
  });
}

export async function buildPoolMerkleContext(
  jobs: DepositJob[],
  targetDepositSignature: string,
  targetInstructionIndex?: number
): Promise<{
  orderedJobs: DepositJob[];
  targetLeafIndex: number;
  root: Uint8Array;
  pathElements: Uint8Array[];
  pathIndices: number[];
}> {
  const withDeposits = jobs.filter((j) => j.deposit);
  if (withDeposits.length === 0) {
    throw new Error('No decoded deposits found for target pool');
  }

  const orderedJobs = sortDepositJobs(withDeposits);

  const tree = new PoseidonMerkleTree();
  await tree.initialize();

  for (const job of orderedJobs) {
    const commitment = hexToBytes(job.deposit!.commitmentHex, 32);
    tree.insert(commitment);
  }

  const targetLeafIndex = orderedJobs.findIndex((j) => {
    if (j.signature !== targetDepositSignature) return false;
    if (targetInstructionIndex === undefined) return true;
    return j.deposit?.instructionIndex === targetInstructionIndex;
  });
  if (targetLeafIndex < 0) {
    throw new Error(
      `Target deposit not found in pool history: ${targetDepositSignature}${
        targetInstructionIndex === undefined ? '' : `:${targetInstructionIndex}`
      }`
    );
  }

  const root = await tree.root();
  const { pathElements, pathIndices } = await tree.getProof(targetLeafIndex);

  return {
    orderedJobs,
    targetLeafIndex,
    root,
    pathElements,
    pathIndices,
  };
}

export async function generateCommitment(
  secret: Uint8Array,
  nullifier: Uint8Array,
  amount: bigint,
  poolAddress: PublicKey
): Promise<Uint8Array> {
  const amountBytes = bigIntToBytes(amount);
  return poseidonN([secret, nullifier, amountBytes, poolAddress.toBytes()]);
}

export async function generateNullifierHash(
  nullifier: Uint8Array,
  poolAddress: PublicKey
): Promise<Uint8Array> {
  return poseidonN([nullifier, poolAddress.toBytes()]);
}

function fieldElementToBytes(element: string): Uint8Array {
  return bigIntToBytes(BigInt(element));
}

function g1PointToBytes(point: [string, string]): Uint8Array {
  const x = fieldElementToBytes(point[0]);
  const y = fieldElementToBytes(point[1]);

  const result = new Uint8Array(64);
  result.set(x, 0);
  result.set(y, 32);
  return result;
}

function g2PointToBytes(point: [[string, string], [string, string]]): Uint8Array {
  const x1 = fieldElementToBytes(point[0][1]);
  const x0 = fieldElementToBytes(point[0][0]);
  const y1 = fieldElementToBytes(point[1][1]);
  const y0 = fieldElementToBytes(point[1][0]);

  const result = new Uint8Array(128);
  result.set(x1, 0);
  result.set(x0, 32);
  result.set(y1, 64);
  result.set(y0, 96);
  return result;
}

export async function generateTransferProof(input: {
  secret: Uint8Array;
  nullifier: Uint8Array;
  amount: bigint;
  pathElements: Uint8Array[];
  pathIndices: number[];
  recipient: PublicKey;
  relayer: PublicKey;
  fee: bigint;
  recipientAmount: bigint;
  root: Uint8Array;
  poolAddress: PublicKey;
  wasmPath: string;
  zkeyPath: string;
}): Promise<{
  nullifierHash: Uint8Array;
  proofA: Uint8Array;
  proofB: Uint8Array;
  proofC: Uint8Array;
  publicInputs: Uint8Array[];
}> {
  const nullifierHash = await generateNullifierHash(input.nullifier, input.poolAddress);

  const circuitInputs = {
    root: toFieldElement(input.root).toString(),
    nullifierHash: toFieldElement(nullifierHash).toString(),
    recipient: toFieldElement(input.recipient.toBytes()).toString(),
    relayer: toFieldElement(input.relayer.toBytes()).toString(),
    fee: input.fee.toString(),
    refund: input.recipientAmount.toString(),
    poolId: toFieldElement(input.poolAddress.toBytes()).toString(),
    secret: toFieldElement(input.secret).toString(),
    nullifier: toFieldElement(input.nullifier).toString(),
    pathElements: input.pathElements.map((x) => toFieldElement(x).toString()),
    pathIndices: input.pathIndices,
    amount: input.amount.toString(),
  };

  const { proof, publicSignals } = await groth16.fullProve(
    circuitInputs,
    input.wasmPath,
    input.zkeyPath
  );

  const proofA = g1PointToBytes([proof.pi_a[0], proof.pi_a[1]]);
  const proofB = g2PointToBytes([
    [proof.pi_b[0][0], proof.pi_b[0][1]],
    [proof.pi_b[1][0], proof.pi_b[1][1]],
  ]);
  const proofC = g1PointToBytes([proof.pi_c[0], proof.pi_c[1]]);

  const publicInputs = publicSignals.map((signal: string) => fieldElementToBytes(signal));

  return {
    nullifierHash,
    proofA,
    proofB,
    proofC,
    publicInputs,
  };
}
