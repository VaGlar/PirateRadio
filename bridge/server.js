require('dotenv').config();

const http = require('http');
const { WebSocketServer } = require('ws');

const {
  ICECAST_SOURCE_PASSWORD,
  ICECAST_HOST = 'localhost',
  ICECAST_PORT = '8000',
  ICECAST_MOUNT = '/radio.webm',
  BROADCAST_PASSWORD,
  BRIDGE_PORT = '3001',
} = process.env;

if (!ICECAST_SOURCE_PASSWORD || !BROADCAST_PASSWORD) {
  console.error('Missing ICECAST_SOURCE_PASSWORD or BROADCAST_PASSWORD. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const wss = new WebSocketServer({ port: Number(BRIDGE_PORT) });
console.log(`Bridge listening on ws://0.0.0.0:${BRIDGE_PORT}`);

let activeBroadcaster = null; // only one on-air source at a time

function openIcecastRequest() {
  const req = http.request({
    host: ICECAST_HOST,
    port: Number(ICECAST_PORT),
    path: ICECAST_MOUNT,
    method: 'PUT',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`source:${ICECAST_SOURCE_PASSWORD}`).toString('base64'),
      'Content-Type': 'audio/webm',
      'Ice-Public': '1',
      'Ice-Name': 'Pirate Radio',
    },
  });
  // Icecast's source protocol expects a raw byte stream, not an HTTP
  // chunked body — without this Node wraps every write() in chunk-size
  // framing (since there's no Content-Length for a live stream), which
  // corrupts the audio.
  req.useChunkedEncodingByDefault = false;
  req.on('error', (err) => console.error('Icecast connection error:', err.message));
  req.on('response', (res) => {
    if (res.statusCode >= 400) {
      console.error(`Icecast rejected the source connection: ${res.statusCode}`);
    }
  });
  return req;
}

wss.on('connection', (ws) => {
  let authed = false;
  let icecastReq = null;

  ws.on('message', (data, isBinary) => {
    if (!authed) {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.close(1008, 'expected auth message');
        return;
      }
      if (msg.type !== 'auth' || msg.password !== BROADCAST_PASSWORD) {
        ws.send(JSON.stringify({ type: 'error', message: 'wrong password' }));
        ws.close(1008, 'unauthorized');
        return;
      }
      if (activeBroadcaster) {
        ws.send(JSON.stringify({ type: 'error', message: 'someone is already on air' }));
        ws.close(1008, 'busy');
        return;
      }
      authed = true;
      activeBroadcaster = ws;
      icecastReq = openIcecastRequest();
      ws.send(JSON.stringify({ type: 'on-air' }));
      console.log('Broadcaster connected, streaming to Icecast');
      return;
    }

    if (isBinary && icecastReq) {
      icecastReq.write(data);
    }
  });

  ws.on('close', () => {
    if (icecastReq) icecastReq.end();
    if (activeBroadcaster === ws) {
      activeBroadcaster = null;
      console.log('Broadcaster disconnected');
    }
  });

  ws.on('error', (err) => console.error('WebSocket error:', err.message));
});
