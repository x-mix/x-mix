import { Connection } from '@solana/web3.js';
import { Logger } from 'pino';
import { getDepositJobKey } from './deposit-key.js';
import { loadRelayRequests, markRequestFailed, markRequestProcessed } from './relay-requests.js';
import { deriveFallbackVault, executeTransfer } from './transfer-executor.js';
import { DepositJob, RelayerConfig, RelayerState } from './types.js';

export async function processRelayQueue(
  connection: Connection,
  state: RelayerState,
  config: RelayerConfig,
  logger: Logger
): Promise<number> {
  let processed = 0;

  const requests = await loadRelayRequests(config, logger);

  for (const job of state.jobs) {
    if (job.status !== 'pending' && job.status !== 'ready') {
      continue;
    }

    // Move newly indexed jobs into waiting state.
    if (job.status === 'pending') {
      job.status = 'ready';
    }

    const request = requests.get(getDepositJobKey(job)) ?? requests.get(job.signature);
    if (!request) {
      continue;
    }

    if (!job.deposit) {
      job.lastError = 'missing decoded deposit payload';
      job.status = 'failed';
      logger.error({ signature: job.signature }, 'Cannot execute relay: missing deposit payload');
      await markRequestFailed(config, request);
      continue;
    }

    if (config.dryRun) {
      logger.info(
        {
          signature: job.signature,
          instructionIndex: job.deposit?.instructionIndex,
          requestId: request.requestId,
          recipient: request.input.recipient,
          amount: request.input.recipientAmountLamports,
        },
        'Dry-run: relay request detected and validated'
      );
      continue;
    }

    try {
      const fallback = {
        pool: request.input.pool ?? job.deposit.pool,
        mint: request.input.mint ?? job.deposit.mint,
        vault:
          request.input.vault ??
          job.deposit.vault ??
          deriveFallbackVault(request.input.pool ?? job.deposit.pool, config),
      };

      const relayedSig = await executeTransfer(
        connection,
        config,
        request,
        fallback,
        logger
      );

      job.status = 'relayed';
      job.relayedSignature = relayedSig;
      job.lastError = undefined;
      processed += 1;

      await markRequestProcessed(config, request);

      logger.info(
        {
          depositSignature: job.signature,
          depositInstructionIndex: job.deposit?.instructionIndex,
          relayedSignature: relayedSig,
          requestId: request.requestId,
        },
        'Relay job executed'
      );
    } catch (error) {
      job.attempts += 1;
      job.lastError = error instanceof Error ? error.message : String(error);
      job.status = job.attempts >= config.maxRelayRetries ? 'failed' : 'ready';

      logger.error(
        {
          signature: job.signature,
          attempts: job.attempts,
          status: job.status,
          error: job.lastError,
        },
        'Relay job failed'
      );

      if (job.status === 'failed') {
        await markRequestFailed(config, request);
      }
    }
  }

  return processed;
}
