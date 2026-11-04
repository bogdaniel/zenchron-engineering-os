import { createServer } from 'node:http';

let waitingForCancellation = false;
const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
    return;
  }
  if (request.method === 'GET' && request.url === '/test-state') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ waitingForCancellation }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions' ||
      request.headers.authorization !== 'Bearer e2e-test-key') {
    response.writeHead(404).end();
    return;
  }

  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const wroteFile = body.messages.some((message) => message.role === 'tool');
      const canWrite = body.tools?.some((tool) => tool.function.name === 'code.write') ?? false;
      const userPrompt = body.messages.filter((message) => message.role === 'user')
        .map((message) => message.content).join('\n');
      const reviewerFeedback = userPrompt.includes('Requested changes:');
      const holdForCancellation = userPrompt.includes('Hold for cancellation after writing partial output.');
      const message = canWrite && !wroteFile ? {
        role: 'assistant',
        tool_calls: [{
          id: 'e2e-write', type: 'function',
          function: { name: 'code.write', arguments: JSON.stringify({
            path: holdForCancellation ? 'partial-output.md' : reviewerFeedback ? 'review-feedback.md' : 'agent-output.md',
            content: holdForCancellation ? 'Partial output before cancellation.\n' : reviewerFeedback
              ? 'Review feedback addressed by the E2E worker.\n' : 'Created by the E2E model.\n',
          }) },
        }],
      } : { role: 'assistant', content: reviewerFeedback
        ? 'E2E model addressed reviewer feedback.' : 'E2E model completed the requested task.' };
      if (holdForCancellation && wroteFile) {
        waitingForCancellation = true;
        const timeout = setTimeout(() => {
          waitingForCancellation = false;
          if (!response.destroyed) response.writeHead(200, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ choices: [{ message }] }));
        }, 30_000);
        response.on('close', () => { clearTimeout(timeout); waitingForCancellation = false; });
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message }] }));
    } catch {
      response.writeHead(400).end();
    }
  });
});

server.listen(Number(process.env.MOCK_LLM_PORT) || 8082, '127.0.0.1');
