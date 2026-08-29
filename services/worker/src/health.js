import http from 'http';

let ready = false;

export function setReady(value) {
  ready = value;
}

export function startHealthServer(port) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'ok' : 'unhealthy', service: 'worker' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, () => console.log(`worker health server listening on ${port}`));
  return server;
}
