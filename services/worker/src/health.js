import http from 'http';
import { register } from './metrics.js';

let ready = false;

export function setReady(value) {
  ready = value;
}

export function startHealthServer(port) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'ok' : 'unhealthy', service: 'worker' }));
      return;
    }
    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': register.contentType });
      res.end(await register.metrics());
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, () => console.log(`worker health server listening on ${port}`));
  return server;
}
