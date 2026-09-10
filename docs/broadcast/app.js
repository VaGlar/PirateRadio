const MIME_TYPE = 'audio/webm;codecs=opus';

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const testBtn = document.getElementById('testBtn');
const micSelect = document.getElementById('micSelect');
const meterBar = document.getElementById('meterBar');
const setupEl = document.getElementById('setup');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');

let ws = null;
let mediaRecorder = null;
let stream = null;
let audioCtx = null;
let analyser = null;
let meterRAF = null;

async function listMicrophones() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    micSelect.innerHTML = '<option value="">(προεπιλογή συστήματος)</option>';
    mics.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Μικρόφωνο ${i + 1}`;
      micSelect.appendChild(opt);
    });
  } catch {
    // enumerateDevices can fail before permission is granted on some browsers — ignore, list refreshes after getUserMedia.
  }
}
listMicrophones();
navigator.mediaDevices.addEventListener?.('devicechange', listMicrophones);

async function acquireStream() {
  const deviceId = micSelect.value;
  const constraints = { audio: deviceId ? { deviceId: { exact: deviceId } } : true };
  const newStream = await navigator.mediaDevices.getUserMedia(constraints);
  await listMicrophones(); // labels are only populated after permission is granted
  return newStream;
}

function startMeter(liveStream) {
  stopMeter();
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  audioCtx.createMediaStreamSource(liveStream).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      peak = Math.max(peak, Math.abs(data[i] - 128));
    }
    meterBar.style.width = Math.min(100, (peak / 128) * 100 * 2.5) + '%';
    meterRAF = requestAnimationFrame(tick);
  };
  tick();
}

function stopMeter() {
  if (meterRAF) cancelAnimationFrame(meterRAF);
  meterRAF = null;
  if (audioCtx) audioCtx.close().catch(() => {});
  audioCtx = null;
  analyser = null;
  meterBar.style.width = '0%';
}

testBtn.addEventListener('click', async () => {
  errorEl.textContent = '';
  try {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = await acquireStream();
    startMeter(stream);
  } catch (err) {
    errorEl.textContent = 'Δεν δόθηκε πρόσβαση στο μικρόφωνο: ' + err.message;
  }
});

startBtn.addEventListener('click', async () => {
  errorEl.textContent = '';
  const password = document.getElementById('password').value;
  const bridgeUrl = document.getElementById('bridgeUrl').value.trim();

  if (!password || !bridgeUrl) {
    errorEl.textContent = 'Συμπλήρωσε κωδικό και διεύθυνση bridge.';
    return;
  }

  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported(MIME_TYPE)) {
    errorEl.textContent = 'Αυτός ο browser δεν υποστηρίζει webm/opus εγγραφή (π.χ. Safari σε iPhone/iPad). Δοκίμασε Chrome ή Firefox σε laptop/Android.';
    return;
  }

  try {
    // Reuse the stream from "Δοκιμή μικροφώνου" if it's already the selected device, otherwise (re)acquire it.
    if (!stream || stream.getAudioTracks().some((t) => t.readyState === 'ended')) {
      stream = await acquireStream();
    }
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

  startMeter(stream); // keep the meter running while live too, as a sanity check

  mediaRecorder = new MediaRecorder(stream, { mimeType: MIME_TYPE });
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
  stopMeter();
  mediaRecorder = null;
  stream = null;
  ws = null;
  setupEl.style.display = 'block';
  stopBtn.style.display = 'none';
  statusEl.textContent = 'Off air';
  statusEl.className = 'off';
}

stopBtn.addEventListener('click', cleanup);
