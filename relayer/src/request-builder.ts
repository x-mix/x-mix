import 'dotenv/config';
import { PublicKey } from '@solana/web3.js';
import { loadConfig } from './config.js';
import { buildRelayRequestFromState } from './request-service.js';
import { StateStore } from './store.js';

type CliArgs = {
  depositSignature?: string;
  recipient?: string;
  secretHex?: string;
  nullifierHex?: string;
  relayerFeeLamports?: string;
  recipientAmountLamports?: string;
  requestId?: string;
  wasmPath?: string;
  zkeyPath?: string;
};

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;

    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) continue;

    i += 1;

    switch (key) {
      case 'deposit-signature':
        out.depositSignature = value;
        break;
      case 'recipient':
        out.recipient = value;
        break;
      case 'secret-hex':
        out.secretHex = value;
        break;
      case 'nullifier-hex':
        out.nullifierHex = value;
        break;
      case 'relayer-fee-lamports':
        out.relayerFeeLamports = value;
        break;
      case 'recipient-amount-lamports':
        out.recipientAmountLamports = value;
        break;
      case 'request-id':
        out.requestId = value;
        break;
      case 'wasm-path':
        out.wasmPath = value;
        break;
      case 'zkey-path':
        out.zkeyPath = value;
        break;
      default:
        break;
    }
  }

  return out;
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required argument: --${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const args = parseArgs(process.argv.slice(2));

  const depositSignature = requireArg(args.depositSignature, 'deposit-signature');
  const recipientRaw = requireArg(args.recipient, 'recipient');
  const secretHex = requireArg(args.secretHex, 'secret-hex');
  const nullifierHex = requireArg(args.nullifierHex, 'nullifier-hex');

  // Validate recipient format early.
  new PublicKey(recipientRaw);

  const store = new StateStore(config.statePath);
  const state = await store.load();

  const result = await buildRelayRequestFromState({
    state,
    config,
    depositSignature,
    recipient: recipientRaw,
    secretHex,
    nullifierHex,
    relayerFeeLamports: args.relayerFeeLamports,
    recipientAmountLamports: args.recipientAmountLamports,
    requestId: args.requestId,
    wasmPath: args.wasmPath,
    zkeyPath: args.zkeyPath,
    writeToQueue: true,
  });

  console.log('relay request written:', result.filePath ?? '(no file)');
  console.log('request id:', result.requestId);
  console.log('deposit signature:', depositSignature);
  console.log('pool:', result.pool);
  console.log('leaf index:', result.leafIndex);
  console.log('relayer fee:', result.request.relayerFeeLamports);
  console.log('recipient amount:', result.request.recipientAmountLamports);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
