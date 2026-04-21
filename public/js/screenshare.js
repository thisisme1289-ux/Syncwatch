/* screenshare.js — WebRTC screen share (host broadcasts, guests receive) */

let hostStream = null;
let hostPC = null;       // single peer connection (one-guest limitation noted)
let guestPC = null;
let _socket = null;
let _roomId = null;

// ── Secure context guard ────────────────────────────────────────────────────
function isScreenShareAvailable() {
  if (!window.isSecureContext) return false;
  if (!navigator.mediaDevices) return false;
  if (typeof navigator.mediaDevices.getDisplayMedia !== 'function') return false;
  return true;
}

function showSSUnavailable() {
  const msg =
    window.location.protocol === 'http:' && window.location.hostname !== 'localhost'
      ? 'Screen share requires HTTPS. Either use localhost or serve the app over HTTPS.'
      : 'Your browser does not support screen sharing (getDisplayMedia unavailable).';

  // Replace host prompt with a clear error panel
  const prompt = document.getElementById('ss-host-prompt');
  if (prompt) {
    prompt.innerHTML = `
      <p style="color:var(--danger);font-weight:600;">Screen share unavailable</p>
      <p class="note" style="max-width:320px;text-align:center;">${msg}</p>
    `;
  }
}

// ── Host side ───────────────────────────────────────────────────────────────
async function startScreenShare(socket, roomId) {
  _socket = socket;
  _roomId = roomId;

  if (!isScreenShareAvailable()) {
    showSSUnavailable();
    return;
  }

  try {
    hostStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 }, cursor: 'always' },
      audio: false,
    });
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      showToast('Screen share permission denied.');
    } else {
      showToast('Screen share failed: ' + err.message);
    }
    return;
  }

  // Show local preview
  const video = document.getElementById('ss-video');
  if (video) {
    video.srcObject = hostStream;
    video.style.display = 'block';
    video.muted = true;
    video.play().catch(() => {});
  }
  document.getElementById('ss-host-prompt').style.display = 'none';

  // Create peer connection and send offer
  hostPC = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

  hostStream.getTracks().forEach(track => hostPC.addTrack(track, hostStream));

  hostPC.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit('ss_ice', { roomId, candidate: candidate.toJSON() });
    }
  };

  hostPC.onconnectionstatechange = () => {
    if (['failed', 'disconnected'].includes(hostPC.connectionState)) {
      showToast('Screen share connection lost.');
    }
  };

  try {
    const offer = await hostPC.createOffer();
    await hostPC.setLocalDescription(offer);
    socket.emit('ss_offer', { roomId, offer: hostPC.localDescription });
  } catch (err) {
    showToast('Failed to create screen share offer: ' + err.message);
    stopScreenShare(socket, roomId);
    return;
  }

  // Stop sharing when user clicks "Stop sharing" in browser UI
  hostStream.getVideoTracks()[0].onended = () => stopScreenShare(socket, roomId);
}

async function handleAnswer(answer) {
  if (!hostPC) return;
  try {
    await hostPC.setRemoteDescription(new RTCSessionDescription(answer));
  } catch (err) {
    showToast('Screen share answer error: ' + err.message);
  }
}

async function handleHostIce(candidate) {
  if (!hostPC) return;
  try {
    await hostPC.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (_) {}
}

function stopScreenShare(socket, roomId) {
  if (hostStream) {
    hostStream.getTracks().forEach(t => t.stop());
    hostStream = null;
  }
  if (hostPC) {
    hostPC.close();
    hostPC = null;
  }
  const video = document.getElementById('ss-video');
  if (video) { video.srcObject = null; video.style.display = 'none'; }
  document.getElementById('ss-host-prompt').style.display = 'flex';
  socket.emit('ss_stopped', { roomId });
}

// ── Guest side ──────────────────────────────────────────────────────────────
async function receiveScreenShare(socket, roomId, offer) {
  _socket = socket;
  _roomId = roomId;

  if (guestPC) { guestPC.close(); guestPC = null; }

  guestPC = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

  guestPC.ontrack = ({ streams }) => {
    const video = document.getElementById('ss-video');
    if (video && streams[0]) {
      video.srcObject = streams[0];
      video.style.display = 'block';
      video.play().catch(() => {});
    }
    document.getElementById('ss-guest-prompt').style.display = 'none';
  };

  guestPC.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit('ss_ice', { roomId, candidate: candidate.toJSON() });
    }
  };

  guestPC.onconnectionstatechange = () => {
    if (['failed', 'disconnected'].includes(guestPC.connectionState)) {
      showToast('Screen share stream lost.');
      resetGuestView();
    }
  };

  try {
    await guestPC.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await guestPC.createAnswer();
    await guestPC.setLocalDescription(answer);
    socket.emit('ss_answer', { roomId, answer: guestPC.localDescription });
  } catch (err) {
    showToast('Failed to connect to screen share: ' + err.message);
  }
}

async function handleGuestIce(candidate) {
  if (!guestPC) return;
  try {
    await guestPC.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (_) {}
}

function resetGuestView() {
  const video = document.getElementById('ss-video');
  if (video) { video.srcObject = null; video.style.display = 'none'; }
  const prompt = document.getElementById('ss-guest-prompt');
  if (prompt) prompt.style.display = 'flex';
  if (guestPC) { guestPC.close(); guestPC = null; }
}

// ── Public API ───────────────────────────────────────────────────────────────
window.ScreenShare = {
  start: startScreenShare,
  stop: stopScreenShare,
  handleAnswer,
  handleHostIce,
  receiveScreenShare,
  handleGuestIce,
  resetGuestView,
  isAvailable: isScreenShareAvailable,
};
