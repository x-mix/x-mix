import http, { IncomingMessage, ServerResponse } from 'node:http';
import { Logger } from 'pino';
import { buildRelayRequestFromState } from './request-service.js';
import { RelayerConfig, RelayerState } from './types.js';

interface RelayRequestBuildBody {
  note?: {
    depositSignature?: string;
    secretHex?: string;
    nullifierHex?: string;
  };
  depositSignature?: string;
  secretHex?: string;
  nullifierHex?: string;
  recipient?: string;
  relayerFeeLamports?: string;
  recipientAmountLamports?: string;
  requestId?: string;
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

export function startApiServer(
  state: RelayerState,
  config: RelayerConfig,
  logger: Logger
): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const url = req.url ?? '/';

      if (method === 'OPTIONS') {
        setCors(res, config);
        res.statusCode = 204;
        res.end();
        return;
      }

      if (method === 'GET' && url === '/health') {
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

      if (method === 'POST' && url === '/api/relay-request/build') {
        const body = (await readJsonBody(req)) as RelayRequestBuildBody;

        const note = body.note ?? {};
        const depositSignature = body.depositSignature ?? note.depositSignature;
        const secretHex = body.secretHex ?? note.secretHex;
        const nullifierHex = body.nullifierHex ?? note.nullifierHex;

        if (!depositSignature || !secretHex || !nullifierHex) {
          writeJson(
            res,
            400,
            {
              ok: false,
              error:
                'missing required fields: depositSignature, secretHex, nullifierHex (or in note)',
            },
            config
          );
          return;
        }

        if (!body.recipient) {
          writeJson(res, 400, { ok: false, error: 'missing required field: recipient' }, config);
          return;
        }

        const result = await buildRelayRequestFromState({
          state,
          config,
          depositSignature,
          recipient: body.recipient,
          secretHex,
          nullifierHex,
          relayerFeeLamports: body.relayerFeeLamports,
          recipientAmountLamports: body.recipientAmountLamports,
          requestId: body.requestId,
          writeToQueue: true,
        });

        writeJson(
          res,
          200,
          {
            ok: true,
            result: {
              requestId: result.requestId,
              filePath: result.filePath,
              depositSignature,
              pool: result.pool,
              mint: result.mint,
              leafIndex: result.leafIndex,
              depositAmountLamports: result.depositAmountLamports,
              relayerFeeLamports: result.request.relayerFeeLamports,
              recipientAmountLamports: result.request.recipientAmountLamports,
            },
          },
          config
        );

        logger.info(
          {
            requestId: result.requestId,
            depositSignature,
            pool: result.pool,
            recipient: body.recipient,
          },
          'relay request built via API'
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
