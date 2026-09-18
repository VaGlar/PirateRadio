const BRIDGE_URL = 'wss://pirateradio-bridge.fly.dev';
const ICECAST_STATUS_URL = 'https://pirateradio-icecast.fly.dev/status-json.xsl';

// Neon "ON AIR" sign lights up while the listener is actually playing —
// simplest possible signal, no extra polling needed. The tab title flips
// to match too, so a backgrounded tab is still noticeable in the tab bar.
const ORIGINAL_TITLE = document.title;
const onairSign = document.getElementById('onairSign');
const radioPlayer = document.getElementById('radioPlayer');
radioPlayer.addEventListener('play', () => { onairSign.classList.add('lit'); document.title = '🔴 LIVE — Pirate Radio'; });
radioPlayer.addEventListener('pause', () => { onairSign.classList.remove('lit'); document.title = ORIGINAL_TITLE; });
radioPlayer.addEventListener('ended', () => { onairSign.classList.remove('lit'); document.title = ORIGINAL_TITLE; });
radioPlayer.addEventListener('error', () => { onairSign.classList.remove('lit'); document.title = ORIGINAL_TITLE; });

// iOS (and other OSes) show a "Now Playing" card in Control Center/lock
// screen for any playing <audio> — the Media Session API is what puts an
// icon on it. Drawn by hand with canvas paths instead of rendering the 🏴‍☠️
// emoji — canvas text doesn't reliably apply the ZWJ ligature that joins
// the flag+skull into one glyph (it can fall back to two separate glyphs,
// landing off-center), and a transparent background gets backfilled white
// by iOS's card — drawing shapes on a solid dark background sidesteps both.
if ('mediaSession' in navigator) {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0d0b0a';
  ctx.fillRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;
  ctx.fillStyle = '#f2ece2';

  // Crossbones
  ctx.strokeStyle = '#f2ece2';
  ctx.lineWidth = 28;
  ctx.lineCap = 'round';
  [Math.PI / 4, -Math.PI / 4].forEach((angle) => {
    ctx.save();
    ctx.translate(cx, cy + 110);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(-150, 0);
    ctx.lineTo(150, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(-150, 0, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(150, 0, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  // Skull dome + jaw
  ctx.beginPath();
  ctx.arc(cx, cy - 40, 120, Math.PI, 0);
  ctx.lineTo(cx + 120, cy + 30);
  ctx.quadraticCurveTo(cx + 120, cy + 80, cx + 70, cy + 80);
  ctx.lineTo(cx + 70, cy + 110);
  ctx.lineTo(cx - 70, cy + 110);
  ctx.lineTo(cx - 70, cy + 80);
  ctx.quadraticCurveTo(cx - 120, cy + 80, cx - 120, cy + 30);
  ctx.closePath();
  ctx.fill();

  // Eye sockets
  ctx.fillStyle = '#0d0b0a';
  ctx.beginPath();
  ctx.ellipse(cx - 48, cy - 30, 30, 40, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx + 48, cy - 30, 30, 40, 0, 0, Math.PI * 2);
  ctx.fill();

  // Nose
  ctx.beginPath();
  ctx.moveTo(cx, cy - 5);
  ctx.lineTo(cx - 20, cy + 35);
  ctx.lineTo(cx + 20, cy + 35);
  ctx.closePath();
  ctx.fill();

  // Teeth gaps
  for (let i = -1.5; i <= 1.5; i++) {
    ctx.fillRect(cx + i * 22 - 5, cy + 80, 10, 30);
  }

  const artworkUrl = canvas.toDataURL('image/png');

  navigator.mediaSession.metadata = new MediaMetadata({
    title: 'Pirate Radio',
    artist: 'Ζωντανή εκπομπή',
    artwork: [{ src: artworkUrl, sizes: '512x512', type: 'image/png' }],
  });

  radioPlayer.addEventListener('play', () => { navigator.mediaSession.playbackState = 'playing'; });
  radioPlayer.addEventListener('pause', () => { navigator.mediaSession.playbackState = 'paused'; });
}

// Custom player bar (play/pause, reload, volume, mute, AirPlay) instead of
// the native <audio controls> UI — the native one exposes a "..." overflow
// menu with captions/playback-speed options that don't make sense for a
// live radio stream and that the browser won't let us remove individually.
const playBtn = document.getElementById('playBtn');
const refreshBtn = document.getElementById('refreshBtn');
const volumeSlider = document.getElementById('volumeSlider');
const muteVolBtn = document.getElementById('muteVolBtn');
const airplayBtn = document.getElementById('airplayBtn');

// Tracks what the listener actually wants, separate from radioPlayer.paused
// — a network drop pauses playback too, but that's not the listener asking
// to stop, so auto-reconnect only kicks in while this stays true.
let listenerWantsPlay = false;

playBtn.addEventListener('click', () => {
  if (radioPlayer.paused) {
    listenerWantsPlay = true;
    radioPlayer.play().catch(() => {});
  } else {
    listenerWantsPlay = false;
    radioPlayer.pause();
  }
});
radioPlayer.addEventListener('play', () => { playBtn.textContent = '⏸'; playBtn.setAttribute('aria-label', 'Pause'); });
radioPlayer.addEventListener('pause', () => { playBtn.textContent = '▶'; playBtn.setAttribute('aria-label', 'Play'); });

function reloadAndPlay() {
  radioPlayer.pause();
  radioPlayer.load();
  radioPlayer.play().catch(() => {});
}

// "Refresh" reconnects to the live stream from scratch — useful if the
// connection stalled or glitched, same idea as reloading a live radio tab.
refreshBtn.addEventListener('click', () => {
  const wasPlaying = !radioPlayer.paused;
  listenerWantsPlay = wasPlaying;
  if (wasPlaying) reloadAndPlay();
  else { radioPlayer.pause(); radioPlayer.load(); }
});

// Auto-reconnect: a live stream can drop mid-listen (WiFi hiccup, the
// broadcaster's own network blip, an Icecast hiccup) without the listener
// doing anything — 'error' and 'stalled' are the two events a dead
// connection actually fires. Retry once every 5s for as long as the
// listener still wants to be playing, instead of leaving them stuck on a
// silently-broken player until they notice and refresh manually.
let reconnectTimer = null;
function scheduleReconnect() {
  if (!listenerWantsPlay || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (listenerWantsPlay) reloadAndPlay();
  }, 5000);
}
radioPlayer.addEventListener('error', scheduleReconnect);
radioPlayer.addEventListener('stalled', scheduleReconnect);

// Same listener count the broadcaster sees, polled independently here —
// small social nudge ("3 άλλοι ακούνε ήδη") rather than something the
// listener has to take on faith.
const listenerCountValue = document.getElementById('listenerCountValue');
async function pollListenerCount() {
  try {
    const res = await fetch(ICECAST_STATUS_URL, { cache: 'no-store' });
    const data = await res.json();
    const sources = [].concat(data?.icestats?.source ?? []);
    const listeners = sources.reduce((sum, s) => sum + (s.listeners || 0), 0);
    listenerCountValue.textContent = listeners;
  } catch {
    listenerCountValue.textContent = '—';
  }
}
pollListenerCount();
setInterval(pollListenerCount, 10000);

function updateVolIcon() {
  muteVolBtn.textContent = radioPlayer.muted || radioPlayer.volume === 0 ? '🔇' : '🔊';
}
volumeSlider.addEventListener('input', () => {
  radioPlayer.volume = Number(volumeSlider.value) / 100;
  if (radioPlayer.volume > 0) radioPlayer.muted = false;
  updateVolIcon();
});
muteVolBtn.addEventListener('click', () => {
  radioPlayer.muted = !radioPlayer.muted;
  updateVolIcon();
});

// AirPlay device picking is a Safari-only API — hide the button everywhere
// else instead of showing something that does nothing.
if (typeof radioPlayer.webkitShowPlaybackTargetPicker === 'function') {
  airplayBtn.style.display = 'inline-block';
  airplayBtn.addEventListener('click', () => radioPlayer.webkitShowPlaybackTargetPicker());
}

const chatName = document.getElementById('chatName');
const chatMessage = document.getElementById('chatMessage');
const chatSend = document.getElementById('chatSend');
const chatStatus = document.getElementById('chatStatus');
const chatListEl = document.getElementById('chatList');

let ws = null;
let listenerName = ''; // set once the login gate is passed — see bottom of file

// Tracks the message currently in flight so we know, when the bridge
// echoes it back (or rejects it), whether that's the one we're waiting on
// — see sendMessage() / the 'chat-message' handler below.
let pendingSend = null; // { name, text } or null

// The bridge fans every chat message out to the broadcaster AND every
// logged-in listener — this is a shared chat, not a one-way inbox to the
// broadcaster — so this renders it the same way for everyone, sender
// included (confirms the message actually went through).
function addChatMessage(msg) {
  const empty = document.getElementById('chatEmpty');
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

  chatListEl.appendChild(el);
  chatListEl.scrollTop = chatListEl.scrollHeight;
}

function ensureConnection() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return ws;
  ws = new WebSocket(BRIDGE_URL);
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'chat-message') {
      addChatMessage(msg);
      // Only clear the compose box once this specific message is actually
      // confirmed sent (the bridge echoes it back to the sender too) —
      // not optimistically on send, so a rate-limited message doesn't
      // vanish from the box before it's actually gone through.
      if (pendingSend && msg.name === pendingSend.name && msg.message === pendingSend.text) {
        pendingSend = null;
        chatMessage.value = '';
        chatSend.disabled = false;
        chatStatus.textContent = '✅ Στάλθηκε!';
        setTimeout(() => {
          if (chatStatus.textContent === '✅ Στάλθηκε!') chatStatus.textContent = '';
        }, 3000);
      }
    } else if (msg.type === 'chat-error') {
      // The bridge rate-limits chat (a few messages go through immediately,
      // then one every few seconds). Leave whatever's typed in the box —
      // it never went out — so the person doesn't have to retype it, just
      // wait and hit send again.
      pendingSend = null;
      chatSend.disabled = false;
      chatStatus.textContent = '⏳ ' + msg.message;
      setTimeout(() => {
        if (chatStatus.textContent === '⏳ ' + msg.message) chatStatus.textContent = '';
      }, 4000);
    }
  });
  return ws;
}

function sendMessage() {
  const text = chatMessage.value.trim();
  if (!text) return;

  chatSend.disabled = true;
  const socket = ensureConnection();
  const name = chatName.value.trim() || 'Ανώνυμος';

  const doSend = () => {
    pendingSend = { name, text };
    socket.send(JSON.stringify({ type: 'chat', name, message: text }));
  };

  if (socket.readyState === WebSocket.OPEN) {
    doSend();
  } else {
    socket.addEventListener('open', doSend, { once: true });
    socket.addEventListener(
      'error',
      () => {
        chatStatus.textContent = '⚠️ Δεν στάλθηκε — δοκίμασε ξανά.';
        chatSend.disabled = false;
      },
      { once: true }
    );
  }
}

chatSend.addEventListener('click', sendMessage);
chatMessage.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Name + shared-passphrase gate — lets the broadcaster see who's listening
// and keeps casual passers-by out. The passphrase is checked by the bridge
// (not hardcoded here) so the broadcaster can change it live from their
// setup screen — how the new passphrase reaches everyone is on them
// (Slack, shouting across the office, whatever), not something this page
// automates. Still a courtesy lock for the crew, not real security.
const LOGIN_STORAGE_KEY = 'pirateradio-login';

const loginGate = document.getElementById('loginGate');
const mainContent = document.getElementById('mainContent');
const loginNameInput = document.getElementById('loginName');
const loginPassInput = document.getElementById('loginPass');
const loginBtn = document.getElementById('loginBtn');
const loginError = document.getElementById('loginError');

function enterSite(name) {
  listenerName = name;
  loginGate.style.display = 'none';
  mainContent.style.display = 'block';
  chatName.value = name;
}

// Sends 'listener-login' to the bridge and waits for ok/error. `fromStorage`
// marks a silent retry using a remembered passphrase (page reload) — if
// that one's rejected (the broadcaster changed it since), the saved login
// is cleared and the gate shows again instead of erroring at someone who
// didn't just type anything.
function attemptLogin(name, passphrase, { fromStorage } = {}) {
  const socket = ensureConnection();

  const handleMessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type !== 'listener-login-ok' && msg.type !== 'listener-login-error') return;
    socket.removeEventListener('message', handleMessage);
    loginBtn.disabled = false;

    if (msg.type === 'listener-login-ok') {
      localStorage.setItem(LOGIN_STORAGE_KEY, JSON.stringify({ name, passphrase }));
      enterSite(name);
    } else if (fromStorage) {
      localStorage.removeItem(LOGIN_STORAGE_KEY);
    } else {
      loginError.textContent = 'Λάθος κωδικός.';
    }
  };
  socket.addEventListener('message', handleMessage);

  const send = () => socket.send(JSON.stringify({ type: 'listener-login', name, passphrase }));
  if (socket.readyState === WebSocket.OPEN) send();
  else socket.addEventListener('open', send, { once: true });
}

loginBtn.addEventListener('click', () => {
  const name = loginNameInput.value.trim();
  const passphrase = loginPassInput.value;
  if (!name) {
    loginError.textContent = 'Γράψε το όνομά σου.';
    return;
  }
  if (!passphrase) {
    loginError.textContent = 'Γράψε τον κωδικό.';
    return;
  }
  loginError.textContent = '';
  loginBtn.disabled = true;
  attemptLogin(name, passphrase);
});
loginPassInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loginBtn.click();
});

try {
  const saved = JSON.parse(localStorage.getItem(LOGIN_STORAGE_KEY) || 'null');
  if (saved && saved.name && saved.passphrase) attemptLogin(saved.name, saved.passphrase, { fromStorage: true });
} catch {
  // corrupted localStorage value — just show the login gate normally
}
