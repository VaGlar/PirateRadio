const MIME_TYPE = 'audio/webm;codecs=opus';
const BRIDGE_URL = 'wss://pirateradio-bridge.fly.dev';
const ICECAST_STATUS_URL = 'https://pirateradio-icecast.fly.dev/status-json.xsl';

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const testBtn = document.getElementById('testBtn');
const micSelect = document.getElementById('micSelect');
const meterBar = document.getElementById('meterBar');
const setupEl = document.getElementById('setup');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
const monitorToggle = document.getElementById('monitorToggle');
const muteBtn = document.getElementById('muteBtn');
const muteHintEl = document.getElementById('muteHint');
const liveControlsEl = document.getElementById('liveControls');
const liveStatsEl = document.getElementById('liveStats');
const elapsedEl = document.getElementById('elapsed');
const listenerCountEl = document.getElementById('listenerCount');
const peakCountEl = document.getElementById('peakCount');
const inboxEl = document.getElementById('inbox');
const inboxListEl = document.getElementById('inboxList');
const sysAudioCheck = document.getElementById('sysAudioCheck');
const mixSliderWrap = document.getElementById('mixSliderWrap');
const mixSliderEl = document.getElementById('mixSlider');

let ws = null;
let mediaRecorder = null;
let stream = null; // raw mic MediaStream (mute toggles tracks on this)
let sysStream = null; // raw system/tab-audio MediaStream from getDisplayMedia

let audioCtx = null;
let mixDest = null; // MediaStreamAudioDestinationNode — MediaRecorder reads from mixDest.stream
let analyser = null;
let monitorGain = null;
let limiter = null;
let micSourceNode = null;
let micGainNode = null;
let sysSourceNode = null;
let sysGainNode = null;
let meterRAF = null;

let onAirAt = 0;
let elapsedTimer = null;
let statsTimer = null;
let peakListeners = 0;
let isMuted = false;

// One persistent Web Audio graph for the whole page session: mic and
// (optionally) system audio each go through their own GainNode into a
// shared MediaStreamAudioDestinationNode — that combined stream is what
// actually gets recorded/broadcast. This is the same idea as a hardware
// mixer or VB-Cable/Voicemeeter, just implemented in the browser instead
// of an OS driver, so it works on machines where installing anything
// isn't possible.
function ensureAudioGraph() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  mixDest = audioCtx.createMediaStreamDestination();

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;

  // Mic + music summed together can exceed 0dB and clip — Web Audio just
  // adds signals linearly with no automatic ceiling. Clipping is exactly
  // what "πολύ πρίμα"/harsh-thin-distorted sound is: it chops the peaks
  // off the waveform, which adds harsh high-frequency harmonics. A limiter
  // on the combined signal keeps peaks under control instead.
  limiter = audioCtx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 6;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.15;

  limiter.connect(mixDest);
  limiter.connect(analyser);

  // Self-monitor destination. Mic always feeds it (via the limiter); system
  // audio (if attached) does too — see attachSysAudio — so once you've
  // muted the original source (e.g. muted the Chrome tab) this is the only
  // place you hear it, and it's the exact mixed signal being broadcast.
  monitorGain = audioCtx.createGain();
  monitorGain.gain.value = monitorToggle.checked ? 1 : 0;
  limiter.connect(monitorGain);
  monitorGain.connect(audioCtx.destination);

  startMeterLoop();
}

function startMeterLoop() {
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

// Single crossfader instead of two independent volume sliders: 0 = full
// mic, 100 = full music, 50 = equal-power blend of both (cos/sin instead
// of a straight linear ramp so the perceived loudness stays roughly
// constant across the slider instead of dipping in the middle). Mic stays
// at full volume regardless of the slider until music is actually
// attached — there's nothing to fade against yet.
function updateMixGains() {
  const pos = Number(mixSliderEl.value) / 100;
  if (micGainNode) micGainNode.gain.value = sysGainNode ? Math.cos((pos * Math.PI) / 2) : 1;
  if (sysGainNode) sysGainNode.gain.value = Math.sin((pos * Math.PI) / 2);
}
mixSliderEl.addEventListener('input', updateMixGains);

function attachMic(newStream) {
  ensureAudioGraph();
  if (micSourceNode) micSourceNode.disconnect();
  micSourceNode = audioCtx.createMediaStreamSource(newStream);
  if (!micGainNode) micGainNode = audioCtx.createGain();
  micSourceNode.connect(micGainNode);
  micGainNode.connect(limiter);
  updateMixGains();
}

async function attachSysAudio() {
  const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  const audioTracks = display.getAudioTracks();
  display.getVideoTracks().forEach((t) => t.stop()); // we only wanted the audio
  if (audioTracks.length === 0) {
    display.getTracks().forEach((t) => t.stop());
    throw new Error('Δεν βρέθηκε ήχος — βεβαιώσου ότι τσέκαρες "Share audio"/"Share tab audio".');
  }

  ensureAudioGraph();
  sysStream = new MediaStream(audioTracks);
  sysSourceNode = audioCtx.createMediaStreamSource(sysStream);
  sysGainNode = audioCtx.createGain();
  sysSourceNode.connect(sysGainNode);
  sysGainNode.connect(limiter);
  updateMixGains();

  audioTracks[0].addEventListener('ended', () => {
    // user stopped sharing from the browser's own "Stop sharing" bar
    detachSysAudio();
    sysAudioCheck.checked = false;
  });
}

function detachSysAudio() {
  if (sysSourceNode) sysSourceNode.disconnect();
  if (sysGainNode) sysGainNode.disconnect();
  sysSourceNode = null;
  sysGainNode = null;
  if (sysStream) sysStream.getTracks().forEach((t) => t.stop());
  sysStream = null;
  updateMixGains(); // back to mic-only, full volume
  mixSliderWrap.style.display = 'none';
}

sysAudioCheck.addEventListener('change', async () => {
  errorEl.textContent = '';
  if (sysAudioCheck.checked) {
    try {
      await attachSysAudio();
      mixSliderWrap.style.display = 'block';
    } catch (err) {
      errorEl.textContent = 'Spotify/ήχος υπολογιστή: ' + err.message;
      sysAudioCheck.checked = false;
    }
  } else {
    detachSysAudio();
  }
});

// Mutes the mic only (system audio, if attached, keeps playing) by
// disabling the track rather than stopping it — MediaRecorder keeps
// running and sends silence instead, so the connection to Icecast never
// drops.
function setMuted(muted) {
  isMuted = muted;
  if (stream) stream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  muteBtn.textContent = muted ? '🔇 MUTED — πάτα για LIVE' : '🎤 LIVE (πάτα για Mute)';
  muteBtn.classList.toggle('muted', muted);
  document.body.classList.toggle('muted-bg', muted);
}
muteBtn.addEventListener('click', () => setMuted(!isMuted));

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  const tag = (e.target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return; // don't hijack typing
  if (!ws || ws.readyState !== WebSocket.OPEN) return; // only while actually on air
  e.preventDefault();
  setMuted(!isMuted);
});

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
  try {
    const res = await fetch(ICECAST_STATUS_URL, { cache: 'no-store' });
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
    attachMic(stream);
    updateMonitor();
  } catch (err) {
    errorEl.textContent = 'Δεν δόθηκε πρόσβαση στο μικρόφωνο: ' + err.message;
  }
});

startBtn.addEventListener('click', async () => {
  errorEl.textContent = '';
  const password = document.getElementById('password').value;

  if (!password) {
    errorEl.textContent = 'Συμπλήρωσε τον κωδικό εκπομπής.';
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
    attachMic(stream);
  } catch (err) {
    errorEl.textContent = 'Δεν δόθηκε πρόσβαση στο μικρόφωνο: ' + err.message;
    return;
  }

  ws = new WebSocket(BRIDGE_URL);
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
    } else if (msg.type === 'chat-message') {
      addChatMessage(msg);
    }
  };

  ws.onerror = () => {
    errorEl.textContent = 'Πρόβλημα σύνδεσης με το bridge.';
  };

  ws.onclose = () => {
    cleanup();
  };
});

function addChatMessage(msg) {
  const empty = document.getElementById('inboxEmpty');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.className = 'msg';
  const time = new Date(msg.ts || Date.now()).toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit' });
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = (msg.name || 'Ανώνυμος') + ': ';
  const timeEl = document.createElement('span');
  timeEl.className = 'time';
  timeEl.textContent = time;
  el.appendChild(name);
  el.appendChild(document.createTextNode(msg.message || ''));
  el.appendChild(timeEl);

  inboxListEl.appendChild(el);
  inboxListEl.scrollTop = inboxListEl.scrollHeight;
}

function goLive() {
  setupEl.style.display = 'none';
  stopBtn.style.display = 'inline-block';
  muteBtn.style.display = 'block';
  muteHintEl.style.display = 'block';
  liveControlsEl.style.display = 'block';
  setMuted(false);
  statusEl.textContent = '🔴 ON AIR';
  statusEl.className = 'live';

  updateMonitor();

  onAirAt = Date.now();
  peakListeners = 0;
  liveStatsEl.style.display = 'block';
  inboxEl.style.display = 'block';
  inboxListEl.innerHTML = '<div id="inboxEmpty">Κανένα μήνυμα ακόμα.</div>';
  elapsedTimer = setInterval(() => {
    elapsedEl.textContent = formatElapsed(Date.now() - onAirAt);
  }, 1000);
  pollStats();
  statsTimer = setInterval(pollStats, 5000);

  // Browsers default MediaRecorder's audio bitrate low (tuned for voice
  // calls, not music) — for music input especially, that gets re-compressed
  // again into MP3 downstream and the result sounds noisy. Force a bitrate
  // high enough for clean music before that happens. Records the *mixed*
  // stream (mic [+ system audio if attached]), not the raw mic.
  mediaRecorder = new MediaRecorder(mixDest.stream, { mimeType: MIME_TYPE, audioBitsPerSecond: 192000 });
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
  detachSysAudio();
  sysAudioCheck.checked = false;
  if (ws) ws.close();

  if (meterRAF) cancelAnimationFrame(meterRAF);
  meterRAF = null;
  if (audioCtx) audioCtx.close().catch(() => {});
  audioCtx = null;
  mixDest = null;
  analyser = null;
  monitorGain = null;
  limiter = null;
  micSourceNode = null;
  micGainNode = null;
  meterBar.style.width = '0%';

  if (elapsedTimer) clearInterval(elapsedTimer);
  if (statsTimer) clearInterval(statsTimer);
  elapsedTimer = null;
  statsTimer = null;
  mediaRecorder = null;
  stream = null;
  ws = null;
  setupEl.style.display = 'block';
  stopBtn.style.display = 'none';
  muteBtn.style.display = 'none';
  muteHintEl.style.display = 'none';
  liveControlsEl.style.display = 'none';
  isMuted = false;
  document.body.classList.remove('muted-bg');
  liveStatsEl.style.display = 'none';
  inboxEl.style.display = 'none';
  statusEl.textContent = 'Off air';
  statusEl.className = 'off';
}

stopBtn.addEventListener('click', cleanup);
