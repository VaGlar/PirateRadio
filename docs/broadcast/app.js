const MIME_TYPE = 'audio/webm;codecs=opus';
const BRIDGE_URL = 'wss://pirateradio-bridge.fly.dev';
const ICECAST_STATUS_URL = 'https://pirateradio-icecast.fly.dev/status-json.xsl';

// Running on battery makes Windows/Chrome throttle CPU and audio-processing
// priority to save power — that's a common real cause of crackling/glitches
// in real-time Web Audio apps like this one. Warn early instead of finding
// out mid-broadcast. Battery Status API is Chrome/Edge-only and optional —
// just skip the warning on browsers that don't support it.
const powerWarningEl = document.getElementById('powerWarning');
if (navigator.getBattery) {
  navigator.getBattery().then((battery) => {
    const update = () => {
      powerWarningEl.style.display = battery.charging ? 'none' : 'block';
    };
    update();
    battery.addEventListener('chargingchange', update);
  }).catch(() => {});
}

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const testBtn = document.getElementById('testBtn');
const test2Btn = document.getElementById('test2Btn');
const micSelect = document.getElementById('micSelect');
const mic2Check = document.getElementById('mic2Check');
const mic2Wrap = document.getElementById('mic2Wrap');
const output1Wrap = document.getElementById('output1Wrap');
const mic2Select = document.getElementById('mic2Select');
const meterBar = document.getElementById('meterBar');
const meter2Bar = document.getElementById('meter2Bar');
const lamp1 = document.getElementById('lamp1');
const lamp2 = document.getElementById('lamp2');
const name1Input = document.getElementById('name1Input');
const name2Input = document.getElementById('name2Input');
const hostsLiveEl = document.getElementById('hostsLive');
const hostRow2El = document.getElementById('hostRow2');
const hostName1El = document.getElementById('hostName1');
const hostName2El = document.getElementById('hostName2');
const liveLamp1 = document.getElementById('liveLamp1');
const liveLamp2 = document.getElementById('liveLamp2');
const hostMute1 = document.getElementById('hostMute1');
const hostMute2 = document.getElementById('hostMute2');
const setupEl = document.getElementById('setup');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
const monitorToggle = document.getElementById('monitorToggle');
const muteBtn = document.getElementById('muteBtn');
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
const output1Select = document.getElementById('output1Select');
const output2Select = document.getElementById('output2Select');
const monitorAudio1 = document.getElementById('monitorAudio1');
const monitorAudio2 = document.getElementById('monitorAudio2');

let ws = null;
let mediaRecorder = null;
let stream = null; // raw mic 1 MediaStream (mute toggles tracks on this)
let mic2Stream = null; // raw mic 2 MediaStream — second co-host, same laptop
let sysStream = null; // raw system/tab-audio MediaStream from getDisplayMedia

let audioCtx = null;
let mixDest = null; // MediaStreamAudioDestinationNode — MediaRecorder reads from mixDest.stream
let micAnalyser = null; // per-mic meters/lamps, tapped before the mix so each shows only its own mic
let mic2Analyser = null;
let monitorGain = null;
let monitorDest = null; // only created when 2 co-hosts need separate monitor outputs
let limiter = null;
let micDeEsser = null; // dips the "s"/"sh" sibilance band before the limiter
let mic2DeEsser = null;
let micSourceNode = null;
let micGainNode = null;
let mic2SourceNode = null;
let mic2GainNode = null;
let sysSourceNode = null;
let sysGainNode = null;
let meterRAF = null;

let onAirAt = 0;
let elapsedTimer = null;
let statsTimer = null;
let peakListeners = 0;
let isMuted = false;
let recordedChunks = []; // local-only copy of the broadcast audio, offered as a download when the show ends — no server storage, no cost

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

  // Separate analysers tapped from each mic's own gain node (before the
  // mix) — this is what drives the per-person meter bar + lamp, so each
  // one only reacts to that person's own mic, not the combined signal.
  micAnalyser = audioCtx.createAnalyser();
  micAnalyser.fftSize = 512;
  mic2Analyser = audioCtx.createAnalyser();
  mic2Analyser.fftSize = 512;

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

  // The limiter's fast 2ms attack (needed to catch clipping peaks) also
  // emphasizes sibilance — harsh "s"/"sh" hiss — since those are exactly
  // the fast, high-frequency transients it reacts hardest to. A static
  // dip in the sibilant band, before the limiter sees the signal, tames
  // that without touching the rest of the voice. One per mic so it only
  // ever touches voice, never the music.
  micDeEsser = audioCtx.createBiquadFilter();
  micDeEsser.type = 'peaking';
  micDeEsser.frequency.value = 6500;
  micDeEsser.Q.value = 1.4;
  micDeEsser.gain.value = -8;

  mic2DeEsser = audioCtx.createBiquadFilter();
  mic2DeEsser.type = 'peaking';
  mic2DeEsser.frequency.value = 6500;
  mic2DeEsser.Q.value = 1.4;
  mic2DeEsser.gain.value = -8;

  limiter.connect(mixDest);

  // Self-monitor destination. Mic always feeds it (via the limiter); system
  // audio (if attached) does too — see attachSysAudio — so once you've
  // muted the original source (e.g. muted the Chrome tab) this is the only
  // place you hear it, and it's the exact mixed signal being broadcast.
  monitorGain = audioCtx.createGain();
  monitorGain.gain.value = monitorToggle.checked ? 1 : 0;
  limiter.connect(monitorGain);
  monitorGain.connect(audioCtx.destination);

  // Two co-hosts on two separate USB headsets each need the monitor signal
  // routed to their own physical output device — a single AudioContext can
  // only default to one device, so this switches to a MediaStreamDestination
  // fed into two <audio> elements, each pinned to a device via setSinkId.
  if (mic2Check.checked) setupDualMonitor();

  startMeterLoop();
}

function meterLevel(an, buf) {
  if (!an) return 0;
  an.getByteTimeDomainData(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    peak = Math.max(peak, Math.abs(buf[i] - 128));
  }
  return Math.min(100, (peak / 128) * 100 * 2.5);
}

const LAMP_THRESHOLD = 8; // % level considered "live sound", not just noise floor

function startMeterLoop() {
  const buf1 = new Uint8Array(micAnalyser.frequencyBinCount);
  const buf2 = new Uint8Array(mic2Analyser.frequencyBinCount);
  const tick = () => {
    const level1 = meterLevel(micAnalyser, buf1);
    meterBar.style.width = level1 + '%';
    const on1 = level1 > LAMP_THRESHOLD;
    lamp1.classList.toggle('on', on1);
    liveLamp1.classList.toggle('on', on1);

    const level2 = meterLevel(mic2Analyser, buf2);
    meter2Bar.style.width = level2 + '%';
    const on2 = level2 > LAMP_THRESHOLD;
    lamp2.classList.toggle('on', on2);
    liveLamp2.classList.toggle('on', on2);

    meterRAF = requestAnimationFrame(tick);
  };
  tick();
}

// Routes the self-monitor signal to two independently-chosen output devices
// instead of AudioContext's single default destination.
function setupDualMonitor() {
  if (!audioCtx || !monitorGain) return;
  if (!monitorDest) {
    monitorDest = audioCtx.createMediaStreamDestination();
    monitorGain.connect(monitorDest);
  }
  try {
    monitorGain.disconnect(audioCtx.destination);
  } catch {
    // already disconnected — fine
  }
  monitorAudio1.srcObject = monitorDest.stream;
  monitorAudio2.srcObject = monitorDest.stream;
  monitorAudio1.play().catch(() => {});
  monitorAudio2.play().catch(() => {});
  applyOutputDevice(monitorAudio1, output1Select.value);
  applyOutputDevice(monitorAudio2, output2Select.value);
}

function teardownDualMonitor() {
  if (monitorDest && monitorGain) {
    try {
      monitorGain.disconnect(monitorDest);
    } catch {
      // already disconnected — fine
    }
  }
  monitorDest = null;
  monitorAudio1.pause();
  monitorAudio1.srcObject = null;
  monitorAudio2.pause();
  monitorAudio2.srcObject = null;
  if (audioCtx && monitorGain) monitorGain.connect(audioCtx.destination);
}

async function applyOutputDevice(audioEl, deviceId) {
  if (typeof audioEl.setSinkId !== 'function') {
    errorEl.textContent = 'Ο browser δεν υποστηρίζει επιλογή συσκευής εξόδου (δοκίμασε Chrome ή Edge).';
    return;
  }
  try {
    await audioEl.setSinkId(deviceId || '');
  } catch (err) {
    errorEl.textContent = 'Πρόβλημα με τη συσκευή εξόδου: ' + err.message;
  }
}

output1Select.addEventListener('change', () => applyOutputDevice(monitorAudio1, output1Select.value));
output2Select.addEventListener('change', () => applyOutputDevice(monitorAudio2, output2Select.value));

// Single crossfader instead of two independent volume sliders: 0 = full
// mic(s), 100 = full music, 50 = equal-power blend of both (cos/sin instead
// of a straight linear ramp so the perceived loudness stays roughly
// constant across the slider instead of dipping in the middle). Both mics
// move together against the music. Mic stays at full volume regardless of
// the slider until music is actually attached — there's nothing to fade
// against yet.
// Ramp instead of snapping the gain instantly — this matters most now that
// clicking anywhere on the slider can jump it a long way in one go (see
// below): without a ramp that would be an abrupt, audible cut/pop in the
// mix. cancelScheduledValues + setValueAtTime(current) first, so repeated
// calls during a drag each start cleanly from wherever the ramp actually is
// right now instead of stacking on top of each other.
const MIX_RAMP_SEC = 0.2;
function rampGain(node, target) {
  if (!node || !audioCtx) return;
  const now = audioCtx.currentTime;
  node.gain.cancelScheduledValues(now);
  node.gain.setValueAtTime(node.gain.value, now);
  node.gain.linearRampToValueAtTime(target, now + MIX_RAMP_SEC);
}

// Mic capture (with echoCancellation/AGC deliberately off — see acquireStream)
// is naturally much quieter than tab/system audio, which is usually already
// loudness-normalized. Without correcting for that, "50/50" on the slider
// sounds like mostly music. These multipliers only kick in once music is
// actually attached — solo mic broadcasts are unaffected. Starting values;
// nudge them if the balance still feels off either way.
const MIC_MAKEUP_GAIN = 2.0;
const MUSIC_GAIN_SCALE = 0.6;

function updateMixGains() {
  const pos = Number(mixSliderEl.value) / 100;
  if (sysGainNode) {
    rampGain(micGainNode, Math.cos((pos * Math.PI) / 2) * MIC_MAKEUP_GAIN);
    rampGain(mic2GainNode, Math.cos((pos * Math.PI) / 2) * MIC_MAKEUP_GAIN);
    rampGain(sysGainNode, Math.sin((pos * Math.PI) / 2) * MUSIC_GAIN_SCALE);
  } else {
    rampGain(micGainNode, 1);
    rampGain(mic2GainNode, 1);
  }
}
mixSliderEl.addEventListener('input', updateMixGains);

// Drive the slider directly from pointer position instead of relying on the
// browser to detect a grab on the (small) native thumb — press down
// anywhere across the control and it jumps + drags from there immediately,
// tracking the pointer 1:1 for as long as the button stays down. This is
// what actually fixes "it gets stuck and won't slide", not just a bigger
// thumb: you no longer need to land on the thumb pixel at all.
function setMixFromClientX(clientX) {
  const rect = mixSliderEl.getBoundingClientRect();
  const pct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
  mixSliderEl.value = String(Math.round(pct));
  updateMixGains();
}
mixSliderEl.addEventListener('pointerdown', (e) => {
  mixSliderEl.setPointerCapture(e.pointerId);
  setMixFromClientX(e.clientX);
});
mixSliderEl.addEventListener('pointermove', (e) => {
  if (e.buttons !== 1) return;
  setMixFromClientX(e.clientX);
});

function attachMic(newStream) {
  ensureAudioGraph();
  if (micSourceNode) micSourceNode.disconnect();
  micSourceNode = audioCtx.createMediaStreamSource(newStream);
  if (!micGainNode) micGainNode = audioCtx.createGain();
  micSourceNode.connect(micGainNode);
  micGainNode.connect(micDeEsser);
  micDeEsser.connect(limiter);
  micGainNode.connect(micAnalyser);
  updateMixGains();
}

function detachMic1() {
  if (micSourceNode) micSourceNode.disconnect();
  if (micGainNode) micGainNode.disconnect();
  micSourceNode = null;
  micGainNode = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

// Second co-host's mic — same laptop, a different physical input device
// (built-in + USB, two USB mics, etc.). Plain getUserMedia with a second
// deviceId, no virtual audio driver needed at all.
function attachMic2(newStream) {
  ensureAudioGraph();
  if (mic2SourceNode) mic2SourceNode.disconnect();
  mic2SourceNode = audioCtx.createMediaStreamSource(newStream);
  if (!mic2GainNode) mic2GainNode = audioCtx.createGain();
  mic2SourceNode.connect(mic2GainNode);
  mic2GainNode.connect(mic2DeEsser);
  mic2DeEsser.connect(limiter);
  mic2GainNode.connect(mic2Analyser);
  updateMixGains();
}

function detachMic2() {
  if (mic2SourceNode) mic2SourceNode.disconnect();
  if (mic2GainNode) mic2GainNode.disconnect();
  mic2SourceNode = null;
  mic2GainNode = null;
  if (mic2Stream) mic2Stream.getTracks().forEach((t) => t.stop());
  mic2Stream = null;
}

mic2Check.addEventListener('change', () => {
  mic2Wrap.style.display = mic2Check.checked ? 'block' : 'none';
  output1Wrap.style.display = mic2Check.checked ? 'block' : 'none';
  if (mic2Check.checked) {
    ensureAudioGraph();
    setupDualMonitor();
  } else {
    detachMic2();
    teardownDualMonitor();
  }
});

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

// Two layers of mute: the big ON AIR button is a master mute for both mics
// at once (ad breaks, "hold on a sec" for the whole show); the small button
// next to each host's name mutes just that person's own mic, independent
// of the other. Disabling tracks rather than stopping them either way —
// MediaRecorder keeps running and sends silence instead, so the connection
// to Icecast never drops.
let mic1Muted = false;
let mic2Muted = false;

function applyMicEnabled() {
  if (stream) stream.getAudioTracks().forEach((t) => (t.enabled = !isMuted && !mic1Muted));
  if (mic2Stream) mic2Stream.getAudioTracks().forEach((t) => (t.enabled = !isMuted && !mic2Muted));
}

function setMuted(muted) {
  isMuted = muted;
  applyMicEnabled();
  muteBtn.classList.toggle('lit', !muted);
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

hostMute1.addEventListener('click', () => {
  mic1Muted = !mic1Muted;
  applyMicEnabled();
  hostMute1.classList.toggle('muted', mic1Muted);
  hostMute1.textContent = mic1Muted ? '🔇' : '🎙️';
});
hostMute2.addEventListener('click', () => {
  mic2Muted = !mic2Muted;
  applyMicEnabled();
  hostMute2.classList.toggle('muted', mic2Muted);
  hostMute2.textContent = mic2Muted ? '🔇' : '🎙️';
});

function fillDeviceSelects(selects, devices, fallbackLabel) {
  selects.forEach((select) => {
    const prevValue = select.value;
    select.innerHTML = '<option value="">(προεπιλογή συστήματος)</option>';
    devices.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `${fallbackLabel} ${i + 1}`;
      select.appendChild(opt);
    });
    if (devices.some((d) => d.deviceId === prevValue)) select.value = prevValue;
  });
}

// Windows (and the browser) exposes every real device twice or three times
// over — a "default" entry, a "communications" entry, and the actual named
// device — so 2 physical headsets can show up as 6-8 dropdown rows. Those
// duplicates share the real device's groupId, so keep only one row per
// groupId (preferring the entry that isn't the synthetic default/communications
// one, since that's the one with the real, recognizable label).
function dedupeByDevice(devices) {
  const byGroup = new Map();
  for (const d of devices) {
    const key = d.groupId || d.deviceId;
    const isSynthetic = d.deviceId === 'default' || d.deviceId === 'communications';
    const existing = byGroup.get(key);
    if (!existing || (isSynthetic === false && (existing.deviceId === 'default' || existing.deviceId === 'communications'))) {
      byGroup.set(key, d);
    }
  }
  return [...byGroup.values()];
}

async function listMicrophones() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = dedupeByDevice(devices.filter((d) => d.kind === 'audioinput'));
    const outputs = dedupeByDevice(devices.filter((d) => d.kind === 'audiooutput'));
    fillDeviceSelects([micSelect, mic2Select], mics, 'Μικρόφωνο');
    fillDeviceSelects([output1Select, output2Select], outputs, 'Έξοδος');
  } catch {
    // enumerateDevices can fail before permission is granted on some browsers — ignore, list refreshes after getUserMedia.
  }
}
listMicrophones();
navigator.mediaDevices.addEventListener?.('devicechange', listMicrophones);

async function acquireStream(select) {
  const deviceId = select.value;
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

// Forces a fresh getUserMedia for mic 2 every time (test button and On Air
// alike) — unlike mic 1 there's no "reuse if unchanged" optimization yet,
// simplest to reason about.
async function applyMic2() {
  if (mic2Check.checked) {
    if (mic2Stream) mic2Stream.getTracks().forEach((t) => t.stop());
    mic2Stream = await acquireStream(mic2Select);
    attachMic2(mic2Stream);
  } else {
    detachMic2();
  }
}

// Testing one mic at a time (not both together) avoids one mic picking up
// the other person's test speech, and keeps it clear whose lamp/meter is
// whose. Both co-hosts still hear whichever mic is being tested, through
// their own headphones, via the shared monitor bus.
testBtn.addEventListener('click', async () => {
  errorEl.textContent = '';
  try {
    detachMic2();
    stream = await acquireStream(micSelect);
    attachMic(stream);
    updateMonitor();
  } catch (err) {
    errorEl.textContent = 'Δεν δόθηκε πρόσβαση στο μικρόφωνο 1: ' + err.message;
  }
});

test2Btn.addEventListener('click', async () => {
  errorEl.textContent = '';
  try {
    detachMic1();
    mic2Stream = await acquireStream(mic2Select);
    attachMic2(mic2Stream);
    updateMonitor();
  } catch (err) {
    errorEl.textContent = 'Δεν δόθηκε πρόσβαση στο μικρόφωνο 2: ' + err.message;
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
      stream = await acquireStream(micSelect);
    }
    attachMic(stream);
    await applyMic2();
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
  liveControlsEl.style.display = 'block';
  mic1Muted = false;
  mic2Muted = false;
  hostMute1.classList.remove('muted');
  hostMute1.textContent = '🎙️';
  hostMute2.classList.remove('muted');
  hostMute2.textContent = '🎙️';
  setMuted(false);
  statusEl.textContent = 'Ζωντανά τώρα';

  hostName1El.textContent = name1Input.value.trim() || 'Παραγωγός 1';
  hostRow2El.style.display = mic2Check.checked ? 'flex' : 'none';
  if (mic2Check.checked) hostName2El.textContent = name2Input.value.trim() || 'Παραγωγός 2';
  hostsLiveEl.style.display = 'block';

  updateMonitor();

  onAirAt = Date.now();
  peakListeners = 0;
  liveStatsEl.style.display = 'block';
  inboxEl.style.display = 'flex'; // matches #inbox's flex-column CSS so the message list can stretch to fill the column
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
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(mixDest.stream, { mimeType: MIME_TYPE, audioBitsPerSecond: 192000 });
  mediaRecorder.ondataavailable = async (event) => {
    if (event.data.size === 0) return;
    recordedChunks.push(event.data);
    if (ws.readyState === WebSocket.OPEN) {
      const buffer = await event.data.arrayBuffer();
      ws.send(buffer);
    }
  };
  // Wait for the recorder's own 'stop' event rather than prompting right
  // after calling .stop() in cleanup() — 'stop' only fires once the final
  // chunk's 'dataavailable' has actually been processed, so this is what
  // makes sure that trailing fragment isn't missing from the download.
  mediaRecorder.addEventListener('stop', offerRecordingDownload);
  mediaRecorder.start(250); // send a chunk every 250ms
}

// Recording lives only in this tab's memory, never touches the server —
// zero storage cost, but it's gone if you close the tab without saving.
function offerRecordingDownload() {
  if (recordedChunks.length === 0) return;
  const chunks = recordedChunks;
  recordedChunks = [];
  const wantsSave = confirm('Θέλεις να αποθηκεύσεις την ηχογράφηση της εκπομπής στον υπολογιστή σου;');
  if (!wantsSave) return;

  const blob = new Blob(chunks, { type: 'audio/webm' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `pirate-radio-${stamp}.webm`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function cleanup() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  detachMic2(); // stops mic 2's tracks too; leaves the checkbox as-is so it auto-reconnects next broadcast
  detachSysAudio();
  sysAudioCheck.checked = false;
  teardownDualMonitor();
  if (ws) ws.close();

  if (meterRAF) cancelAnimationFrame(meterRAF);
  meterRAF = null;
  if (audioCtx) audioCtx.close().catch(() => {});
  audioCtx = null;
  mixDest = null;
  micAnalyser = null;
  mic2Analyser = null;
  monitorGain = null;
  monitorDest = null;
  limiter = null;
  micDeEsser = null;
  mic2DeEsser = null;
  micSourceNode = null;
  micGainNode = null;
  meterBar.style.width = '0%';
  meter2Bar.style.width = '0%';
  lamp1.classList.remove('on');
  lamp2.classList.remove('on');
  liveLamp1.classList.remove('on');
  liveLamp2.classList.remove('on');
  hostsLiveEl.style.display = 'none';

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
  liveControlsEl.style.display = 'none';
  isMuted = false;
  document.body.classList.remove('muted-bg');
  liveStatsEl.style.display = 'none';
  inboxEl.style.display = 'none';
  statusEl.textContent = 'Off air';
}

stopBtn.addEventListener('click', cleanup);
