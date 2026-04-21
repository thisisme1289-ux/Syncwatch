// screenshare.js - WebRTC screen share, host-to-guests

const ScreenShare = (() => {
  const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
  let localStream = null;
  let peerConnections = new Map(); // socketId -> RTCPeerConnection (host side)
  let receiverPc = null;           // guest side single connection

  // ---- HOST ----
  async function startShare(socket, roomId) {
    try {
      localStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 15, max: 20 },
          width: { ideal: 1280 },
        },
        audio: false,
      });

      const localVid = document.getElementById('ss-video');
      if (localVid) {
        localVid.srcObject = localStream;
        localVid.muted = true;
        localVid.style.display = '';
        document.getElementById('ss-host-prompt').style.display = 'none';
      }

      // When a guest sends an ICE candidate back
      socket.on('ss_ice', ({ candidate }) => {
        peerConnections.forEach(pc => {
          pc.addIceCandidate(candidate).catch(() => {});
        });
      });

      // When a new guest joins, server sends them our offer via user_joined
      // But we need to create an offer per guest. We send one broadcast offer
      // and all guests respond with answers tracked by their socket id.
      await createOfferForRoom(socket, roomId);

      localStream.getVideoTracks()[0].addEventListener('ended', () => {
        stopShare(socket, roomId);
      });

    } catch (err) {
      Utils.toast('Screen share failed: ' + err.message);
    }
  }

  async function createOfferForRoom(socket, roomId) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    peerConnections.set('broadcast', pc);

    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.addEventListener('icecandidate', e => {
      if (e.candidate) socket.emit('ss_ice', { roomId, candidate: e.candidate });
    });

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') capBitrate(pc, 1200);
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('ss_offer', { roomId, offer });
  }

  function handleAnswer(answer) {
    const pc = peerConnections.get('broadcast');
    if (pc && pc.signalingState === 'have-local-offer') {
      pc.setRemoteDescription(answer).catch(() => {});
    }
  }

  function handleIce(candidate) {
    peerConnections.forEach(pc => {
      pc.addIceCandidate(candidate).catch(() => {});
    });
  }

  function stopShare(socket, roomId) {
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    peerConnections.forEach(pc => pc.close());
    peerConnections.clear();
    socket.emit('ss_stopped', { roomId });
    const v = document.getElementById('ss-video');
    if (v) { v.srcObject = null; v.style.display = 'none'; }
    document.getElementById('ss-host-prompt').style.display = '';
    Utils.toast('Screen share stopped');
  }

  // ---- GUEST ----
  function initReceiver(socket, roomId) {
    receiverPc = new RTCPeerConnection({ iceServers: ICE });

    receiverPc.addEventListener('track', e => {
      const vid = document.getElementById('ss-video');
      if (vid) {
        vid.srcObject = e.streams[0];
        vid.style.display = '';
        document.getElementById('ss-guest-prompt').style.display = 'none';
      }
    });

    socket.on('ss_offer', async ({ offer }) => {
      if (!receiverPc) return;
      await receiverPc.setRemoteDescription(offer);
      const answer = await receiverPc.createAnswer();
      await receiverPc.setLocalDescription(answer);
      socket.emit('ss_answer', { roomId, answer });
    });

    socket.on('ss_ice', ({ candidate }) => {
      receiverPc?.addIceCandidate(candidate).catch(() => {});
    });

    receiverPc.addEventListener('icecandidate', e => {
      if (e.candidate) socket.emit('ss_ice', { roomId, candidate: e.candidate });
    });
  }

  // Cap video encoding bitrate
  async function capBitrate(pc, kbps) {
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = kbps * 1000;
      params.encodings[0].maxFramerate = 15;
      await sender.setParameters(params).catch(() => {});
    }
  }

  return { startShare, handleAnswer, handleIce, stopShare, initReceiver };
})();
