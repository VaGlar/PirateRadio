const BRIDGE_URL = 'wss://pirateradio-bridge.fly.dev';
const ICECAST_STATUS_URL = 'https://pirateradio-icecast.fly.dev/status-json.xsl';

// Neon "ON AIR" sign lights up while the listener is actually playing —
// simplest possible signal, no extra polling needed.
const onairSign = document.getElementById('onairSign');
const radioPlayer = document.getElementById('radioPlayer');
radioPlayer.addEventListener('play', () => onairSign.classList.add('lit'));
radioPlayer.addEventListener('pause', () => onairSign.classList.remove('lit'));
radioPlayer.addEventListener('ended', () => onairSign.classList.remove('lit'));
radioPlayer.addEventListener('error', () => onairSign.classList.remove('lit'));

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

let ws = null;
let listenerName = ''; // set once the login gate is passed — see bottom of file

function ensureConnection() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return ws;
  ws = new WebSocket(BRIDGE_URL);
  // Announce this listener to the bridge so the broadcaster can see who's
  // currently on the page, not just a raw connection count.
  ws.addEventListener('open', () => {
    if (listenerName) ws.send(JSON.stringify({ type: 'listener-hello', name: listenerName }));
  });
  return ws;
}

function sendMessage() {
  const text = chatMessage.value.trim();
  if (!text) return;

  chatSend.disabled = true;
  const socket = ensureConnection();

  const doSend = () => {
    socket.send(JSON.stringify({ type: 'chat', name: chatName.value.trim(), message: text }));
    chatMessage.value = '';
    chatStatus.textContent = '✅ Στάλθηκε!';
    chatSend.disabled = false;
    setTimeout(() => {
      if (chatStatus.textContent === '✅ Στάλθηκε!') chatStatus.textContent = '';
    }, 3000);
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

// Simple name + shared-passphrase gate — lets the broadcaster see who's
// listening and keeps casual passers-by out. The passphrase lives in this
// file, which is public source on GitHub Pages, so this is a courtesy
// lock for the crew, not real security — don't put anything sensitive
// behind it.
const LISTENER_PASSPHRASE = 'yohoho';
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
  ensureConnection(); // announce presence right away, even before they send any chat message
}

function attemptLogin() {
  const name = loginNameInput.value.trim();
  if (!name) {
    loginError.textContent = 'Γράψε το όνομά σου.';
    return;
  }
  if (loginPassInput.value !== LISTENER_PASSPHRASE) {
    loginError.textContent = 'Λάθος κωδικός.';
    return;
  }
  loginError.textContent = '';
  localStorage.setItem(LOGIN_STORAGE_KEY, JSON.stringify({ name }));
  enterSite(name);
}

loginBtn.addEventListener('click', attemptLogin);
loginPassInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') attemptLogin();
});

try {
  const saved = JSON.parse(localStorage.getItem(LOGIN_STORAGE_KEY) || 'null');
  if (saved && saved.name) enterSite(saved.name);
} catch {
  // corrupted localStorage value — just show the login gate normally
}
