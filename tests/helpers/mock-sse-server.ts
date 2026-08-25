import {createServer} from 'node:http';
import type {AddressInfo, Socket} from 'node:net';

export interface MockSseServer {
  baseUrl: string;
  requests: Array<{url: string; body: string; authorization: string | undefined}>;
  close(): Promise<void>;
}

export async function startMockSseServer(frames: string[], delay = 0, status = 200): Promise<MockSseServer> {
  const sockets = new Set<Socket>();
  const requests: MockSseServer['requests'] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({url: request.url ?? '', body, authorization: request.headers.authorization});
      response.writeHead(status, {'content-type': 'text/event-stream'});
      let index = 0;
      const send = () => {
        const frame = frames[index++];
        if (frame === undefined) { response.end(); return; }
        response.write(frame);
        if (delay === 0) queueMicrotask(send); else setTimeout(send, delay);
      };
      send();
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
