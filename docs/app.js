const BRIDGE_URL = 'wss://pirateradio-bridge.fly.dev';

// Neon "ON AIR" sign lights up while the listener is actually playing —
// simplest possible signal, no extra polling needed.
const onairSign = document.getElementById('onairSign');
const radioPlayer = document.getElementById('radioPlayer');
radioPlayer.addEventListener('play', () => onairSign.classList.add('lit'));
radioPlayer.addEventListener('pause', () => onairSign.classList.remove('lit'));
radioPlayer.addEventListener('ended', () => onairSign.classList.remove('lit'));
radioPlayer.addEventListener('error', () => onairSign.classList.remove('lit'));

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
