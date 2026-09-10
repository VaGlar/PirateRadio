const BRIDGE_URL = 'wss://pirateradio-bridge.fly.dev';

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

playBtn.addEventListener('click', () => {
  if (radioPlayer.paused) radioPlayer.play().catch(() => {});
  else radioPlayer.pause();
});
radioPlayer.addEventListener('play', () => { playBtn.textContent = '⏸'; playBtn.setAttribute('aria-label', 'Pause'); });
radioPlayer.addEventListener('pause', () => { playBtn.textContent = '▶'; playBtn.setAttribute('aria-label', 'Play'); });

// "Refresh" reconnects to the live stream from scratch — useful if the
// connection stalled or glitched, same idea as reloading a live radio tab.
refreshBtn.addEventListener('click', () => {
  const wasPlaying = !radioPlayer.paused;
  radioPlayer.pause();
  radioPlayer.load();
  if (wasPlaying) radioPlayer.play().catch(() => {});
});

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

function ensureConnection() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return ws;
  ws = new WebSocket(BRIDGE_URL);
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
