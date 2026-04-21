# x-mix relayer

This module is the operational off-chain layer for `x-mix` after on-chain deployment.

Current scope:
- Index `Deposit` activity from chain logs.
- Decode deposit instruction payload (`amount`, `commitment`, `new_root`, `pool`, `mint`).
- Persist queue/state to disk.
- Rebuild per-pool Merkle roots from indexed commitments.
- Compare rebuilt roots vs latest on-chain `new_root` and flag mismatches.
- Consume relay request files and execute on-chain `transfer` instructions.
- Manage relay job lifecycle (`pending -> ready -> relayed/failed`) with retries.
- Build relay request JSON from note inputs with automatic zk proof generation.
- Expose HTTP API so DApp can submit withdrawal requests directly.

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
  - Builds request files via API/CLI but does not send relay transactions.

- `DRY_RUN=false`:
  - Executes relay requests by sending `transfer` transactions.

## HTTP API

When `RELAYER_API_ENABLED=true`, relayer starts an API server.

Default:
- Host: `0.0.0.0`
- Port: `8787`
- CORS: `*`

### `GET /health`

Returns health + queue stats.

### `POST /api/relay-request/build`

Builds proof and writes one request JSON into `REQUESTS_PATH`.

Request body example:

```json
{
  "note": {
    "depositSignature": "...",
    "secretHex": "...",
    "nullifierHex": "..."
  },
  "recipient": "<recipient-pubkey>",
  "relayerFeeLamports": "0",
  "recipientAmountLamports": "7500000000"
}
```

Response example:

```json
{
  "ok": true,
  "result": {
    "requestId": "...",
    "filePath": ".../relayer-data/requests/<id>.json",
    "depositSignature": "...",
    "pool": "...",
    "mint": "...",
    "leafIndex": 12,
    "depositAmountLamports": "7500000000",
    "relayerFeeLamports": "0",
    "recipientAmountLamports": "7500000000"
  }
}
```

## Build relay request from CLI

```bash
cd relayer
npm run request:build -- \
  --deposit-signature <deposit_tx_sig> \
  --recipient <recipient_pubkey> \
  --secret-hex <32-byte-hex> \
  --nullifier-hex <32-byte-hex> \
  --relayer-fee-lamports 0
```

Optional flags:
- `--recipient-amount-lamports` (default: `deposit - relayerFee`)
- `--request-id`
- `--wasm-path`
- `--zkey-path`

## Relay request format

One file per request in `REQUESTS_PATH`.

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
- For SPL token pools (e.g. USDC), request builder now auto-fills
  `vaultTokenAccount` / `recipientTokenAccount` / `feeCollectorTokenAccount`
  using the mint's actual token program owner.
- Processed files are moved to `PROCESSED_REQUESTS_PATH`.
- Permanently failed files are moved to `FAILED_REQUESTS_PATH`.

## State model

`state.json` tracks:
- `lastSeenSlot`: high-water mark for scanned signatures.
- `knownSignatures`: dedupe window.
- `jobs`: relay queue records, retry status, decoded deposit payload, relayed signature.
- `poolSnapshots`: latest on-chain root, rebuilt root, and root-match flag per pool.
