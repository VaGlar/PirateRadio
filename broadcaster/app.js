const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const setupEl = document.getElementById('setup');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');

let ws = null;
let mediaRecorder = null;
let stream = null;

startBtn.addEventListener('click', async () => {
  errorEl.textContent = '';
  const password = document.getElementById('password').value;
  const bridgeUrl = document.getElementById('bridgeUrl').value.trim();

  if (!password || !bridgeUrl) {
    errorEl.textContent = 'Συμπλήρωσε κωδικό και διεύθυνση bridge.';
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    errorEl.textContent = 'Δεν δόθηκε πρόσβαση στο μικρόφωνο: ' + err.message;
    return;
  }

  ws = new WebSocket(bridgeUrl);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', password }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'on-air') {
      goLive();
    } else if (msg.type === 'error') {
      errorEl.textContent = msg.message;
      cleanup();
    }
  };

  ws.onerror = () => {
    errorEl.textContent = 'Πρόβλημα σύνδεσης με το bridge.';
  };

  ws.onclose = () => {
    cleanup();
  };
});

function goLive() {
  setupEl.style.display = 'none';
  stopBtn.style.display = 'inline-block';
  statusEl.textContent = '🔴 ON AIR';
  statusEl.className = 'live';

  mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  mediaRecorder.ondataavailable = async (event) => {
    if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
      const buffer = await event.data.arrayBuffer();
      ws.send(buffer);
    }
  };
  mediaRecorder.start(250); // send a chunk every 250ms
}

function cleanup() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (ws) ws.close();
  mediaRecorder = null;
  stream = null;
  ws = null;
  setupEl.style.display = 'block';
  stopBtn.style.display = 'none';
  statusEl.textContent = 'Off air';
  statusEl.className = 'off';
}

stopBtn.addEventListener('click', cleanup);
