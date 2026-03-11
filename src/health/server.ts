import http from 'node:http';
import type pino from 'pino';
import type { CollectorStatus } from '../types/domain.js';

export interface HealthState {
  status: CollectorStatus;
  lastError?: string;
  updatedAt: string;
}

export function startHealthServer(
  host: string,
  port: number,
  getState: () => HealthState,
  logger: pino.Logger
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url !== '/healthz') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const body = JSON.stringify(getState());
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });

  server.listen(port, host, () => {
    logger.info({ host, port }, 'Health endpoint started');
  });

  return server;
}
