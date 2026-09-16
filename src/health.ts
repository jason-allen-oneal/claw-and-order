import http from 'node:http';

export interface HealthStatus {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  database: 'connected' | 'error';
  discord: {
    ready: boolean;
    pingMs: number;
  };
  counters: Record<string, number>;
}

export function startHealthServer(
  port: number,
  getStatus: () => Promise<HealthStatus>
): { port: () => number; close: () => Promise<void> } {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }
    const path = req.url?.split('?')[0];
    if (path === '/healthz' || path === '/livez' || path === '/health' || path === '/') {
      try {
        const status = await getStatus();
        const code = status.database === 'connected' ? 200 : 503;
        const body = JSON.stringify(status, null, 2);
        res.writeHead(code, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        });
        if (req.method === 'HEAD') res.end();
        else res.end(body);
      } catch {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', database: 'error' }));
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(port, () => {
    console.log(`Claw & Order health endpoint listening on port ${port} (/healthz)`);
  });

  return {
    port: () => {
      const addr = server.address();
      return typeof addr === 'object' && addr ? addr.port : port;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
