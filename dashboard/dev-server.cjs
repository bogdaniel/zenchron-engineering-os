const http = require('node:http');
const https = require('node:https');
const { createServer } = require('http-server');

const api = new URL(process.env.ZENCHRON_API_PROXY || 'http://127.0.0.1:8080');
const transport = api.protocol === 'https:' ? https : http;
const server = createServer({
  root: 'dist',
  cache: -1,
  before: [(request, response) => {
    const incoming = request.request;
    const outgoing = response.response;
    if (!incoming.url.startsWith('/api/')) return response.emit('next');
    const upstream = transport.request({
      hostname: api.hostname, port: api.port || (api.protocol === 'https:' ? 443 : 80),
      path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, host: api.host },
    }, (result) => {
      outgoing.writeHead(result.statusCode, result.headers);
      result.pipe(outgoing);
    });
    upstream.on('error', () => {
      if (outgoing.headersSent) return outgoing.destroy();
      outgoing.writeHead(502).end('API proxy unavailable');
    });
    incoming.pipe(upstream);
  }],
});

server.listen(Number(process.env.ZENCHRON_DASHBOARD_PORT) || 4173, '127.0.0.1');
