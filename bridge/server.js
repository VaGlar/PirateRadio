require('dotenv').config();

const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const {
  ICECAST_SOURCE_PASSWORD,
  ICECAST_HOST = 'localhost',
  ICECAST_PORT = '8000',
  ICECAST_MOUNT = '/radio.mp3',
  BROADCAST_PASSWORD,
  BRIDGE_PORT = '3001',
  PORT, // set automatically by Render (and most PaaS) for the public web service port
} = process.env;

if (!ICECAST_SOURCE_PASSWORD || !BROADCAST_PASSWORD) {
  console.error('Missing ICECAST_SOURCE_PASSWORD or BROADCAST_PASSWORD. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const listenPort = Number(PORT || BRIDGE_PORT);
const wss = new WebSocketServer({ port: listenPort });
console.log(`Bridge listening on ws://0.0.0.0:${listenPort}`);

let activeBroadcaster = null; // only one on-air source at a time

// Browsers don't reliably play a live, indefinite-duration webm/opus stream
// through a plain <audio> tag — MP3 over Icecast is the combination every
// real internet radio setup relies on for that reason. ffmpeg both
// transcodes MediaRecorder's webm/opus output to MP3 and speaks Icecast's
// source protocol itself (far more robust than a hand-rolled HTTP client).
function spawnFfmpeg(ws, stats) {
  const tls = Number(ICECAST_PORT) === 443;
  const icecastUrl = `icecast://source@${ICECAST_HOST}:${ICECAST_PORT}${ICECAST_MOUNT}`;

  const ffmpeg = spawn('ffmpeg', [
    '-loglevel', 'warning',
    '-f', 'webm',
    '-i', 'pipe:0',
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    '-content_type', 'audio/mpeg',
    '-ice_name', 'Pirate Radio',
    '-ice_public', '1',
    '-password', ICECAST_SOURCE_PASSWORD,
    '-tls', tls ? '1' : '0',
    '-f', 'mp3',
    icecastUrl,
  ]);

  ffmpeg.stderr.on('data', (chunk) => {
    console.log('ffmpeg:', chunk.toString().trim());
  });

  ffmpeg.on('error', (err) => {
    console.error('Failed to start ffmpeg:', err.message);
    ws.send(JSON.stringify({ type: 'error', message: 'Failed to start ffmpeg: ' + err.message }));
  });

  ffmpeg.on('exit', (code, signal) => {
    console.log(`ffmpeg exited (code=${code}, signal=${signal}) after +${Date.now() - stats.onAirAt}ms, ${stats.chunkCount} chunks, ${stats.totalBytes}B total`);
    if (code !== 0 && code !== null) {
      ws.send(JSON.stringify({ type: 'error', message: `ffmpeg/Icecast connection failed (exit code ${code}) — check bridge logs` }));
    }
  });

  return ffmpeg;
}

wss.on('connection', (ws) => {
  let authed = false;
  let ffmpeg = null;
  const stats = { onAirAt: 0, totalBytes: 0, chunkCount: 0 };

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
      stats.onAirAt = Date.now();
      ffmpeg = spawnFfmpeg(ws, stats);
      ws.send(JSON.stringify({ type: 'on-air' }));
      console.log('Broadcaster connected, streaming to Icecast via ffmpeg');
      return;
    }

    if (isBinary && ffmpeg && ffmpeg.stdin.writable) {
      stats.totalBytes += data.length;
      stats.chunkCount += 1;
      const ok = ffmpeg.stdin.write(data);
      // Log every 8th chunk (~2s at the browser's 250ms timeslice) so we can
      // see whether audio kept flowing right up to a disconnect, or stalled
      // earlier upstream (browser/WebSocket) before ffmpeg's own connection
      // to Icecast gave up.
      if (stats.chunkCount % 8 === 0) {
        console.log(`+${Date.now() - stats.onAirAt}ms: chunk #${stats.chunkCount}, ${data.length}B (total ${stats.totalBytes}B)${ok ? '' : ' [ffmpeg stdin backpressure]'}`);
      }
    }
  });

  ws.on('close', () => {
    if (ffmpeg) {
      ffmpeg.stdin.end();
      setTimeout(() => ffmpeg.kill(), 2000); // give it a moment to flush, then force-stop
    }
    if (activeBroadcaster === ws) {
      activeBroadcaster = null;
      console.log('Broadcaster disconnected');
    }
  });

  ws.on('error', (err) => console.error('WebSocket error:', err.message));
});
