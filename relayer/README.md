# x-mix relayer (scaffold)

This module is the first operational layer for `x-mix` after on-chain deployment.

Current scope:
- Index `Deposit` activity from chain logs.
- Decode deposit instruction payload (`amount`, `commitment`, `new_root`, `pool`, `mint`).
- Persist queue/state to disk.
- Rebuild per-pool Merkle roots from indexed commitments.
- Compare rebuilt roots vs latest on-chain `new_root` and flag mismatches.
- Consume relay request files and execute on-chain `transfer` instructions.
- Manage relay job lifecycle (`pending -> ready -> relayed/failed`) with retries.
- Build relay request JSON from note inputs (secret/nullifier) with automatic zk proof generation.

## Quick start

1) Copy config template.

```bash
cd relayer
cp .env.example .env
```

2) Fill `.env` values (at minimum `RPC_URL`).

3) Install and run.

```bash
npm install
npm run dev
```

The process writes state to `relayer-data/state.json` by default.

## Runtime modes

- `DRY_RUN=true` (default):
  - Indexes deposits and queues jobs.
  - Rebuilds and validates Merkle roots.
  - Reads request files but does not send relay transactions.

- `DRY_RUN=false`:
  - Executes relay requests by sending `transfer` transactions.

## Build Relay Request from Note

You can generate a request file directly from a deposit note without manually producing `proofA/proofB/proofC`.

```bash
cd relayer
npm run request:build -- \
  --deposit-signature <deposit_tx_sig> \
  --recipient <recipient_pubkey> \
  --secret-hex <32-byte-hex> \
  --nullifier-hex <32-byte-hex> \
  --relayer-fee-lamports 0
```

What this does:
- Loads `state.json` and finds the target deposit.
- Rebuilds pool Merkle tree and computes proof path.
- Validates note commitment against on-chain indexed deposit commitment.
- Generates zk proof using local circuit files.
- Writes a request JSON into `REQUESTS_PATH`.

Optional flags:
- `--recipient-amount-lamports` (default: `deposit - relayerFee`)
- `--request-id`
- `--wasm-path`
- `--zkey-path`

Default circuit paths:
- `../circuits/build/transaction_js/transaction.wasm`
- `../circuits/transaction_0001.zkey`

## Relay request format

Drop one JSON file per request in `REQUESTS_PATH`.

```json
{
  "depositSignature": "<deposit-tx-signature>",
  "recipient": "<recipient-pubkey>",
  "nullifierHashHex": "<64-hex>",
  "proofAHex": "<128-hex>",
  "proofBHex": "<256-hex>",
  "proofCHex": "<128-hex>",
  "publicInputsHex": ["<64-hex>", "...7 total..."],
  "relayerFeeLamports": "0",
  "recipientAmountLamports": "7500000000",
  "pool": "<optional-pool-pubkey>",
  "mint": "<optional-mint-pubkey>",
  "vault": "<optional-vault-pubkey>",
  "vaultTokenAccount": "<optional-token-account>",
  "recipientTokenAccount": "<optional-token-account>",
  "feeCollectorTokenAccount": "<optional-token-account>"
}
```

Notes:
- For SOL pool requests, leave token account fields empty.
- Processed files are moved to `PROCESSED_REQUESTS_PATH`.
- Permanently failed files are moved to `FAILED_REQUESTS_PATH`.

## State model

`state.json` tracks:
- `lastSeenSlot`: high-water mark for scanned signatures.
- `knownSignatures`: dedupe window.
- `jobs`: relay queue records, retry status, decoded deposit payload, relayed signature.
- `poolSnapshots`: latest on-chain root, rebuilt root, and root-match flag per pool.

## Next implementation steps

1) Add a lightweight HTTP API wrapper for request build + submit.
2) Validate request values against rebuilt Merkle tree leaf index/proof path.
3) Add alerting and dead-letter replay tooling.
