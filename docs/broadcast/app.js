const MIME_TYPE = 'audio/webm;codecs=opus';

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const testBtn = document.getElementById('testBtn');
const micSelect = document.getElementById('micSelect');
const meterBar = document.getElementById('meterBar');
const setupEl = document.getElementById('setup');
const setup2El = document.getElementById('setup2');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
const monitorToggle = document.getElementById('monitorToggle');
const liveStatsEl = document.getElementById('liveStats');
const elapsedEl = document.getElementById('elapsed');
const listenerCountEl = document.getElementById('listenerCount');
const peakCountEl = document.getElementById('peakCount');

let ws = null;
let mediaRecorder = null;
let stream = null;
let audioCtx = null;
let analyser = null;
let monitorGain = null;
let meterRAF = null;
let onAirAt = 0;
let elapsedTimer = null;
let statsTimer = null;
let peakListeners = 0;

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
  // echoCancellation/noiseSuppression/autoGainControl are meant for two-way
  // calls — they run real-time DSP on the mic signal that adds noticeable
  // latency (and can dull audio quality), unnecessary here since this is a
  // one-way broadcast mic, not a conferencing input.
  const audioConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (deviceId) audioConstraints.deviceId = { exact: deviceId };
  const newStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  await listMicrophones(); // labels are only populated after permission is granted
  return newStream;
}

function startMeter(liveStream) {
  stopMeter();
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  const source = audioCtx.createMediaStreamSource(liveStream);

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);

  // Self-monitor routed through the same low-latency Web Audio graph
  // instead of a separate <audio> element — an <audio>.srcObject playback
  // path adds a very noticeable extra delay (100-300ms+) on top of what's
  // already an audio pipeline; staying inside the Web Audio graph keeps it
  // down to a few ms, close to actually hearing yourself.
  monitorGain = audioCtx.createGain();
  monitorGain.gain.value = monitorToggle.checked ? 1 : 0;
  source.connect(monitorGain);
  monitorGain.connect(audioCtx.destination);

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
  monitorGain = null;
  meterBar.style.width = '0%';
}

function updateMonitor() {
  if (monitorGain) {
    monitorGain.gain.value = monitorToggle.checked ? 1 : 0;
  }
}
monitorToggle.addEventListener('change', updateMonitor);

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

async function pollStats() {
  const url = document.getElementById('icecastStatusUrl').value.trim();
  if (!url) return;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();
    const sources = [].concat(data?.icestats?.source ?? []);
    const listeners = sources.reduce((sum, s) => sum + (s.listeners || 0), 0);
    const peak = sources.reduce((sum, s) => sum + (s.listener_peak || 0), 0);
    listenerCountEl.textContent = listeners;
    peakListeners = Math.max(peakListeners, peak, listeners);
    peakCountEl.textContent = peakListeners;
  } catch {
    listenerCountEl.textContent = '?';
  }
}

testBtn.addEventListener('click', async () => {
  errorEl.textContent = '';
  try {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = await acquireStream();
    startMeter(stream);
    updateMonitor();
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
  setup2El.style.display = 'none';
  stopBtn.style.display = 'inline-block';
  statusEl.textContent = '🔴 ON AIR';
  statusEl.className = 'live';

  startMeter(stream); // keep the meter running while live too, as a sanity check
  updateMonitor();

  onAirAt = Date.now();
  peakListeners = 0;
  liveStatsEl.style.display = 'block';
  elapsedTimer = setInterval(() => {
    elapsedEl.textContent = formatElapsed(Date.now() - onAirAt);
  }, 1000);
  pollStats();
  statsTimer = setInterval(pollStats, 5000);

  // Browsers default MediaRecorder's audio bitrate low (tuned for voice
  // calls, not music) — for Stereo Mix / music input especially, that gets
  // re-compressed again into MP3 downstream and the result sounds noisy.
  // Force a bitrate high enough for clean music before that happens.
  mediaRecorder = new MediaRecorder(stream, { mimeType: MIME_TYPE, audioBitsPerSecond: 192000 });
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
  if (elapsedTimer) clearInterval(elapsedTimer);
  if (statsTimer) clearInterval(statsTimer);
  elapsedTimer = null;
  statsTimer = null;
  mediaRecorder = null;
  stream = null;
  ws = null;
  setupEl.style.display = 'block';
  setup2El.style.display = 'block';
  stopBtn.style.display = 'none';
  liveStatsEl.style.display = 'none';
  statusEl.textContent = 'Off air';
  statusEl.className = 'off';
}

stopBtn.addEventListener('click', cleanup);
