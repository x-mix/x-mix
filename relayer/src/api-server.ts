import http, { IncomingMessage, ServerResponse } from 'node:http';
import { Connection, PublicKey } from '@solana/web3.js';
import { Logger } from 'pino';
import { ensureDepositHistory, listPoolDeposits } from './deposit-history.js';
import { indexDepositsBySignatures } from './indexer.js';
import { preparePoolRoots } from './merkle.js';
import { buildRelayRequestFromState } from './request-service.js';
import { RelayerConfig, RelayerState } from './types.js';

interface RelayRequestBuildBody {
  note?: {
    depositSignature?: string;
    depositInstructionIndex?: number;
    secretHex?: string;
    nullifierHex?: string;
    mint?: string;
    pool?: string;
    vault?: string;
    vaultTokenAccount?: string;
    recipientTokenAccount?: string;
    feeCollectorTokenAccount?: string;
  };
  depositSignature?: string;
  depositInstructionIndex?: number;
  secretHex?: string;
  nullifierHex?: string;
  recipient?: string;
  relayerFeeLamports?: string;
  recipientAmountLamports?: string;
  requestId?: string;
}

interface RelayRequestBuildBatchBody {
  requests?: RelayRequestBuildBody[];
}

interface DepositPrepareBody {
  pool?: string;
  commitmentsHex?: string[];
}

interface NormalizedBuildInput {
  depositSignature: string;
  depositInstructionIndex?: number;
  secretHex: string;
  nullifierHex: string;
  recipient: string;
  relayerFeeLamports?: string;
  recipientAmountLamports?: string;
  requestId?: string;
}

interface BuildWithRetryResult {
  request: Awaited<ReturnType<typeof buildRelayRequestFromState>>;
  attempts: number;
  indexedOnDemand: number;
  input: NormalizedBuildInput;
}

function setCors(res: ServerResponse, config: RelayerConfig): void {
  res.setHeader('Access-Control-Allow-Origin', config.apiCorsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
  config: RelayerConfig
): void {
  setCors(res, config);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(`${JSON.stringify(payload)}\n`);
}

async function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += piece.length;
    if (size > maxBytes) {
      throw new Error('request body too large');
    }
    chunks.push(piece);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw) as unknown;
}

function getQueueStats(state: RelayerState): {
  pending: number;
  ready: number;
  relayed: number;
  failed: number;
} {
  return {
    pending: state.jobs.filter((j) => j.status === 'pending').length,
    ready: state.jobs.filter((j) => j.status === 'ready').length,
    relayed: state.jobs.filter((j) => j.status === 'relayed').length,
    failed: state.jobs.filter((j) => j.status === 'failed').length,
  };
}

function getPoolCommitments(
  state: RelayerState,
  pool: string,
  limit?: number
): {
  pool: string;
  commitmentCount: number;
  commitmentsHex: string[];
  latestRootHex: string | null;
  computedRootHex: string | null;
  rootMatches: boolean | null;
  lastSeenSlot: number;
  stateUpdatedAt: string;
} {
  ensureDepositHistory(state);
  const ordered = listPoolDeposits(state, pool);
  const all = ordered.map((entry) => entry.commitmentHex);

  const bounded =
    typeof limit === 'number' && Number.isInteger(limit) && limit > 0 && all.length > limit
      ? all.slice(all.length - limit)
      : all;

  const snapshot = state.poolSnapshots[pool];

  return {
    pool,
    commitmentCount: all.length,
    commitmentsHex: bounded,
    latestRootHex: snapshot?.latestRootHex ?? null,
    computedRootHex: snapshot?.computedRootHex ?? null,
    rootMatches: snapshot?.rootMatches ?? null,
    lastSeenSlot: state.lastSeenSlot,
    stateUpdatedAt: state.updatedAt,
  };
}

function parsePositiveInt(value: string | null): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error('limit must be a positive integer');
  }
  return num;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableBuildError(message: string): boolean {
  return (
    message.includes('Deposit not found in relayer state') ||
    message.includes('missing decoded deposit payload')
  );
}

function normalizeBuildInput(body: RelayRequestBuildBody): NormalizedBuildInput {
  const note = body.note ?? {};
  const depositSignature = body.depositSignature ?? note.depositSignature;
  const depositInstructionIndex = body.depositInstructionIndex ?? note.depositInstructionIndex;
  const secretHex = body.secretHex ?? note.secretHex;
  const nullifierHex = body.nullifierHex ?? note.nullifierHex;
  const recipient = body.recipient;

  if (!depositSignature || !secretHex || !nullifierHex) {
    throw new Error(
      'missing required fields: depositSignature, secretHex, nullifierHex (or in note)'
    );
  }
  if (!recipient) {
    throw new Error('missing required field: recipient');
  }

  return {
    depositSignature,
    depositInstructionIndex,
    secretHex,
    nullifierHex,
    recipient,
    relayerFeeLamports: body.relayerFeeLamports,
    recipientAmountLamports: body.recipientAmountLamports,
    requestId: body.requestId,
  };
}

function toBuildResponse(
  input: NormalizedBuildInput,
  result: Awaited<ReturnType<typeof buildRelayRequestFromState>>
): {
  requestId: string;
  filePath?: string;
  depositSignature: string;
  depositInstructionIndex?: number;
  pool: string;
  mint: string;
  vault?: string;
  vaultTokenAccount?: string;
  recipientTokenAccount?: string;
  feeCollectorTokenAccount?: string;
  leafIndex: number;
  depositAmountLamports: string;
  relayerFeeLamports: string;
  recipientAmountLamports: string;
} {
  return {
    requestId: result.requestId,
    filePath: result.filePath,
    depositSignature: input.depositSignature,
    depositInstructionIndex: result.request.depositInstructionIndex,
    pool: result.pool,
    mint: result.mint,
    vault: result.request.vault,
    vaultTokenAccount: result.request.vaultTokenAccount,
    recipientTokenAccount: result.request.recipientTokenAccount,
    feeCollectorTokenAccount: result.request.feeCollectorTokenAccount,
    leafIndex: result.leafIndex,
    depositAmountLamports: result.depositAmountLamports,
    relayerFeeLamports: result.request.relayerFeeLamports,
    recipientAmountLamports: result.request.recipientAmountLamports,
  };
}

async function buildRelayRequestWithRetry(
  state: RelayerState,
  config: RelayerConfig,
  logger: Logger,
  connection: Connection,
  input: NormalizedBuildInput
): Promise<BuildWithRetryResult> {
  const totalAttempts = Math.max(1, config.apiBuildRetryAttempts);
  let attempt = 0;
  let indexedOnDemand = 0;
  let result: Awaited<ReturnType<typeof buildRelayRequestFromState>> | undefined;
  let lastErrorMessage = '';

  while (attempt < totalAttempts) {
    attempt += 1;
    try {
      result = await buildRelayRequestFromState({
        state,
        config,
        depositSignature: input.depositSignature,
        depositInstructionIndex: input.depositInstructionIndex,
        recipient: input.recipient,
        secretHex: input.secretHex,
        nullifierHex: input.nullifierHex,
        relayerFeeLamports: input.relayerFeeLamports,
        recipientAmountLamports: input.recipientAmountLamports,
        requestId: input.requestId,
        writeToQueue: true,
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastErrorMessage = message;

      if (!isRetryableBuildError(message) || attempt >= totalAttempts) {
        break;
      }

      const indexed = await indexDepositsBySignatures(connection, config, state, logger, [
        input.depositSignature,
      ]);
      indexedOnDemand += indexed;

      logger.warn(
        {
          depositSignature: input.depositSignature,
          depositInstructionIndex: input.depositInstructionIndex,
          attempt,
          totalAttempts,
          indexed,
          indexedOnDemand,
          error: message,
        },
        'relay request build hit missing deposit; attempted on-demand indexing'
      );

      if (indexed === 0 && config.apiBuildRetryDelayMs > 0) {
        // Give RPC a brief window to surface just-confirmed transactions.
        // eslint-disable-next-line no-await-in-loop
        await sleep(config.apiBuildRetryDelayMs);
      }
    }
  }

  if (!result) {
    throw new Error(lastErrorMessage || 'failed to build relay request');
  }

  return {
    request: result,
    attempts: attempt,
    indexedOnDemand,
    input,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      // eslint-disable-next-line no-await-in-loop
      results[current] = await worker(items[current], current);
    }
  });

  await Promise.all(runners);
  return results;
}

export function startApiServer(
  state: RelayerState,
  config: RelayerConfig,
  logger: Logger,
  connection: Connection
): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const rawUrl = req.url ?? '/';
      const parsedUrl = new URL(rawUrl, 'http://localhost');
      const pathname = parsedUrl.pathname;

      if (method === 'OPTIONS') {
        setCors(res, config);
        res.statusCode = 204;
        res.end();
        return;
      }

      if (method === 'GET' && pathname === '/health') {
        writeJson(
          res,
          200,
          {
            ok: true,
            service: 'x-mix-relayer-api',
            dryRun: config.dryRun,
            updatedAt: state.updatedAt,
            queue: getQueueStats(state),
          },
          config
        );
        return;
      }

      if (method === 'GET' && /^\/api\/pool\/[^/]+\/commitments$/.test(pathname)) {
        const parts = pathname.split('/');
        const pool = parts[3];

        try {
          new PublicKey(pool);
        } catch {
          writeJson(res, 400, { ok: false, error: 'invalid pool address' }, config);
          return;
        }

        const limit = parsePositiveInt(parsedUrl.searchParams.get('limit'));
        const result = getPoolCommitments(state, pool, limit);

        writeJson(res, 200, { ok: true, result }, config);
        return;
      }

      if (method === 'POST' && pathname === '/api/deposit/prepare') {
        const body = (await readJsonBody(req)) as DepositPrepareBody;
        const pool = body.pool?.trim();
        const commitmentsHex = Array.isArray(body.commitmentsHex) ? body.commitmentsHex : [];
        const maxBatchSize = 20;

        if (!pool) {
          writeJson(res, 400, { ok: false, error: 'missing required field: pool' }, config);
          return;
        }
        try {
          new PublicKey(pool);
        } catch {
          writeJson(res, 400, { ok: false, error: 'invalid pool address' }, config);
          return;
        }
        if (commitmentsHex.length === 0) {
          writeJson(
            res,
            400,
            { ok: false, error: 'commitmentsHex must be a non-empty array' },
            config
          );
          return;
        }
        if (commitmentsHex.length > maxBatchSize) {
          writeJson(
            res,
            400,
            { ok: false, error: `commitmentsHex exceeds max limit ${maxBatchSize}` },
            config
          );
          return;
        }

        const snapshot = state.poolSnapshots[pool];
        if (snapshot?.rootMatches === false) {
          writeJson(
            res,
            409,
            {
              ok: false,
              error: `pool snapshot root mismatch (computed=${snapshot.computedRootHex ?? 'n/a'} latest=${snapshot.latestRootHex ?? 'n/a'})`,
            },
            config
          );
          return;
        }

        const result = await preparePoolRoots(state, pool, commitmentsHex);
        writeJson(res, 200, { ok: true, result }, config);
        return;
      }

      if (method === 'POST' && pathname === '/api/relay-request/build') {
        const body = (await readJsonBody(req)) as RelayRequestBuildBody;
        let input: NormalizedBuildInput;
        try {
          input = normalizeBuildInput(body);
        } catch (error) {
          writeJson(
            res,
            400,
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            config
          );
          return;
        }
        const built = await buildRelayRequestWithRetry(state, config, logger, connection, input);

        writeJson(
          res,
          200,
          {
            ok: true,
            result: toBuildResponse(input, built.request),
          },
          config
        );

        logger.info(
          {
            requestId: built.request.requestId,
            depositSignature: input.depositSignature,
            depositInstructionIndex: built.request.request.depositInstructionIndex,
            pool: built.request.pool,
            recipient: input.recipient,
            attempts: built.attempts,
            indexedOnDemand: built.indexedOnDemand,
          },
          'relay request built via API'
        );

        return;
      }

      if (method === 'POST' && pathname === '/api/relay-request/build-batch') {
        const body = (await readJsonBody(req)) as RelayRequestBuildBatchBody;
        const requests = Array.isArray(body.requests) ? body.requests : [];
        const maxBatchSize = 20;

        if (requests.length === 0) {
          writeJson(res, 400, { ok: false, error: 'requests must be a non-empty array' }, config);
          return;
        }
        if (requests.length > maxBatchSize) {
          writeJson(
            res,
            400,
            { ok: false, error: `batch size exceeds max limit ${maxBatchSize}` },
            config
          );
          return;
        }

        const results: Array<
          | {
              ok: true;
              result: ReturnType<typeof toBuildResponse>;
            }
          | {
              ok: false;
              error: string;
            }
        > = new Array(requests.length);

        const normalizedInputs: Array<NormalizedBuildInput | null> = requests.map(
          () => null
        );
        for (let i = 0; i < requests.length; i += 1) {
          try {
            normalizedInputs[i] = normalizeBuildInput(requests[i]);
          } catch (error) {
            results[i] = {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        const preloadSignatures = Array.from(
          new Set(
            normalizedInputs
              .filter((item): item is NormalizedBuildInput => item !== null)
              .map((item) => item.depositSignature)
          )
        );
        if (preloadSignatures.length > 0) {
          try {
            const indexed = await indexDepositsBySignatures(
              connection,
              config,
              state,
              logger,
              preloadSignatures
            );
            logger.info(
              { preloadSignatures: preloadSignatures.length, indexed },
              'batch relay-request pre-index completed'
            );
          } catch (error) {
            logger.warn(
              { error: error instanceof Error ? error.message : String(error) },
              'batch relay-request pre-index failed; continuing with per-item retry'
            );
          }
        }

        const pendingIndexes = normalizedInputs
          .map((input, index) => ({ input, index }))
          .filter((item): item is { input: NormalizedBuildInput; index: number } => item.input !== null);

        const concurrency = Math.max(
          1,
          Math.min(config.apiBuildBatchConcurrency, pendingIndexes.length || 1)
        );
        const builtItems: Array<
          | {
              index: number;
              ok: true;
              result: ReturnType<typeof toBuildResponse>;
            }
          | {
              index: number;
              ok: false;
              error: string;
            }
        > = await mapWithConcurrency(
          pendingIndexes,
          concurrency,
          async ({ input, index }) => {
            try {
              const built = await buildRelayRequestWithRetry(
                state,
                config,
                logger,
                connection,
                input
              );

              logger.info(
                {
                  index,
                  requestId: built.request.requestId,
                  depositSignature: input.depositSignature,
                  depositInstructionIndex: built.request.request.depositInstructionIndex,
                  pool: built.request.pool,
                  recipient: input.recipient,
                  attempts: built.attempts,
                  indexedOnDemand: built.indexedOnDemand,
                },
                'relay request built via batch API'
              );

              return {
                index,
                ok: true,
                result: toBuildResponse(input, built.request),
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              logger.warn({ index, error: message }, 'batch relay request build failed');
              return {
                index,
                ok: false,
                error: message,
              };
            }
          }
        );

        for (const item of builtItems) {
          if (item.ok) {
            results[item.index] = { ok: true, result: item.result };
            continue;
          }
          results[item.index] = { ok: false, error: item.error };
        }

        const failed = results.filter((item) => !item.ok).length;
        writeJson(
          res,
          200,
          {
            ok: true,
            results,
            summary: {
              total: requests.length,
              success: requests.length - failed,
              failed,
            },
          },
          config
        );
        return;
      }

      writeJson(res, 404, { ok: false, error: 'not found' }, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error: message }, 'relayer api request failed');
      writeJson(res, 500, { ok: false, error: message }, config);
    }
  });

  server.listen(config.apiPort, config.apiHost, () => {
    logger.info(
      {
        host: config.apiHost,
        port: config.apiPort,
        corsOrigin: config.apiCorsOrigin,
      },
      'relayer api server started'
    );
  });

  return server;
}
