import bs58 from 'bs58';
import { PartiallyDecodedInstruction } from '@solana/web3.js';
import { DepositPayload } from './types.js';

const DEPOSIT_DISCRIMINATOR = Buffer.from([
  242, 35, 198, 137, 82, 225, 242, 182,
]);

const DEPOSIT_DATA_SIZE = 8 + 8 + 32 + 32;

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function decodeDepositInstruction(
  ix: PartiallyDecodedInstruction,
  instructionIndex: number
): DepositPayload | null {
  if (ix.accounts.length < 4) {
    return null;
  }

  const raw = bs58.decode(ix.data);
  if (raw.length < DEPOSIT_DATA_SIZE) {
    return null;
  }

  if (!Buffer.from(raw.subarray(0, 8)).equals(DEPOSIT_DISCRIMINATOR)) {
    return null;
  }

  const amount = Buffer.from(raw.subarray(8, 16)).readBigUInt64LE(0);
  const commitment = raw.subarray(16, 48);
  const newRoot = raw.subarray(48, 80);

  return {
    depositor: ix.accounts[0].toBase58(),
    pool: ix.accounts[1].toBase58(),
    mint: ix.accounts[2].toBase58(),
    vault: ix.accounts[3].toBase58(),
    amount: amount.toString(),
    commitmentHex: toHex(commitment),
    newRootHex: toHex(newRoot),
    instructionIndex,
  };
}
