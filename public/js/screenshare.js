/*
  screenshare.js
  WebRTC screen share — host broadcasts, guests receive.
  Self-contained: call ScreenShare.init(socket, roomId, isHost) once.
  All socket listeners are registered here; app.js needs no ss_ wiring.

  Socket event contract (must match server/socket.js):
    Client -> Server:
      ss_offer   { roomId, offer }
      ss_answer  { roomId, answer }
      ss_ice     { roomId, candidate, to? }
      ss_stopped { roomId }

    Server -> Client:
      ss_offer   { offer }
      ss_answer  { answer, from }
      ss_ice     { candidate, from }
      ss_stopped (no payload)
*/

(function () {
  'use strict';

  /* ── module state ───────────────────────────────────────────────────────── */
  var _socket   = null;
  var _roomId   = null;
  var _isHost   = false;

  // Host: one RTCPeerConnection per guest socket id  { guestId -> RTCPeerConnection }
  var _hostPCs  = {};
  var _hostStream = null;

  // Guest: single connection back to host
  var _guestPC  = null;

  /* ── ICE server config ──────────────────────────────────────────────────── */
  var ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  /* ── safe DOM helpers ───────────────────────────────────────────────────── */
  function el(id) { return document.getElementById(id); }

  function showEl(id)  { var e = el(id); if (e) e.style.display = 'flex'; }
  function hideEl(id)  { var e = el(id); if (e) e.style.display = 'none'; }

  function setVideoStream(stream) {
    var v = el('ss-video');
    if (!v) return;
    v.srcObject = stream || null;
    if (stream) {
      v.style.display = 'block';
      v.play().catch(function () {});
    } else {
      v.style.display = 'none';
    }
  }

  function toast(msg) {
    /* falls back gracefully if utils.js showToast is not loaded yet */
    if (typeof showToast === 'function') {
      showToast(msg);
    } else {
      console.warn('[ScreenShare]', msg);
    }
  }

  /* ── environment checks ─────────────────────────────────────────────────── */

  /*
    ROOT CAUSE:
    navigator.mediaDevices is undefined when:
      1. Page is served over plain HTTP on a non-localhost origin.
         Browsers gate the mediaDevices API behind a secure context.
      2. The browser is genuinely old and does not implement the API.

    Fix: guard every access behind isSupported() before touching
    navigator.mediaDevices at all.
  */
  function isSupported() {
    if (typeof navigator === 'undefined')          return false;
    if (!navigator.mediaDevices)                   return false;
    if (!navigator.mediaDevices.getDisplayMedia)   return false;
    return true;
  }

  function isSecureOrigin() {
    /* window.isSecureContext is true for https:// and http://localhost */
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      return false;
    }
    return true;
  }

  function showUnavailableError() {
    var prompt = el('ss-host-prompt');
    if (!prompt) return;

    var reason = '';
    if (!isSecureOrigin()) {
      reason = 'Screen sharing requires a secure connection (HTTPS or localhost). ' +
               'Please serve this app over HTTPS or access it via localhost.';
    } else {
      reason = 'Your browser does not support screen sharing. ' +
               'Use a recent version of Chrome, Edge, or Firefox.';
    }

    prompt.innerHTML =
      '<p style="color:var(--danger);font-weight:600;margin-bottom:0.5rem;">Screen share unavailable</p>' +
      '<p class="note" style="max-width:320px;text-align:center;">' + reason + '</p>';
    prompt.style.display = 'flex';
  }

  /* ── peer connection factory ────────────────────────────────────────────── */
  function makePeerConnection() {
    return new RTCPeerConnection(ICE_CONFIG);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     HOST SIDE
     ═══════════════════════════════════════════════════════════════════════════ */

  /*
    startScreenShare()
    1. Guards: support check, secure context check.
    2. Calls getDisplayMedia — user picks what to share.
    3. Stores stream, shows local preview.
    4. Does NOT create a peer connection yet — waits for guests to answer.
       When a guest joins and the host has a stream, the host will call
       _createHostPCForGuest(guestId) upon receiving ss_answer.

    Actually the correct WebRTC flow for broadcast is:
    Host creates offer -> sends to room -> each guest answers individually.

    We support N guests by keeping _hostPCs map keyed by guest socket id.
  */
  function startScreenShare() {
    if (!isSupported() || !isSecureOrigin()) {
      showUnavailableError();
      return;
    }

    navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: 'always',
        frameRate: { ideal: 15, max: 30 },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    }).then(function (stream) {
      _hostStream = stream;

      /* show local preview */
      setVideoStream(stream);
      hideEl('ss-host-prompt');

      /* send offer to the whole room — each guest will answer individually */
      _sendOfferToRoom();

      /* when the user clicks "Stop sharing" in the browser's built-in bar */
      var videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = function () {
          stopScreenShare();
        };
      }

    }).catch(function (err) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        toast('Screen share permission denied.');
      } else if (err.name === 'NotFoundError') {
        toast('No screen available to share.');
      } else if (err.name === 'NotSupportedError') {
        toast('Screen sharing is not supported in this browser.');
      } else {
        toast('Screen share failed: ' + err.message);
      }
      console.error('[ScreenShare] getDisplayMedia error:', err);
    });
  }

  /* Create an RTCPeerConnection for one guest and send them an offer */
  function _sendOfferToRoom() {
    if (!_hostStream) return;

    /* We broadcast one offer to the room.
       Each guest that receives it will send back an individual ss_answer.
       We create the PC lazily when we receive each answer (see _handleAnswerFromGuest).

       However we need to create at least one PC now to generate the offer SDP,
       then clone that SDP for any additional guests.

       Simpler and more compatible approach: create ONE initial offer PC,
       send the offer, then for each answering guest create a fresh PC
       with the same tracks and complete the handshake.
    */

    var pc = makePeerConnection();
    _hostPCs['__offer__'] = pc;

    _hostStream.getTracks().forEach(function (track) {
      pc.addTrack(track, _hostStream);
    });

    pc.onicecandidate = function (evt) {
      if (evt.candidate) {
        _socket.emit('ss_ice', {
          roomId:    _roomId,
          candidate: evt.candidate.toJSON(),
          /* no 'to' -> server broadcasts to whole room */
        });
      }
    };

    pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer).then(function () {
        _socket.emit('ss_offer', { roomId: _roomId, offer: pc.localDescription });
      });
    }).catch(function (err) {
      toast('Failed to create screen share offer: ' + err.message);
      console.error('[ScreenShare] createOffer error:', err);
      stopScreenShare();
    });
  }

  /* Called when a guest sends back ss_answer { answer, from } */
  function _handleAnswerFromGuest(answer, guestId) {
    if (!_hostStream) return;

    /* reuse the offer PC for the first guest, create new ones for others */
    var pc = _hostPCs[guestId];
    if (!pc) {
      if (_hostPCs['__offer__'] && !_hostPCs['__offer__'].__used) {
        pc = _hostPCs['__offer__'];
        pc.__used = true;
        _hostPCs[guestId] = pc;
        delete _hostPCs['__offer__'];
      } else {
        /* create a fresh PC for this additional guest */
        pc = makePeerConnection();
        _hostPCs[guestId] = pc;

        _hostStream.getTracks().forEach(function (track) {
          pc.addTrack(track, _hostStream);
        });

        pc.onicecandidate = function (evt) {
          if (evt.candidate) {
            _socket.emit('ss_ice', {
              roomId:    _roomId,
              candidate: evt.candidate.toJSON(),
              to:        guestId,   /* direct to this guest */
            });
          }
        };
      }
    }

    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        _cleanupHostPC(guestId);
      }
    };

    pc.setRemoteDescription(new RTCSessionDescription(answer)).catch(function (err) {
      console.error('[ScreenShare] setRemoteDescription (host) error:', err);
    });
  }

  /* Called when ICE candidate arrives for host (from a specific guest) */
  function _handleHostIce(candidate, fromGuestId) {
    var pc = _hostPCs[fromGuestId] || _hostPCs['__offer__'];
    if (!pc) return;
    pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(function (err) {
      console.warn('[ScreenShare] addIceCandidate (host) error:', err.message);
    });
  }

  function _cleanupHostPC(guestId) {
    var pc = _hostPCs[guestId];
    if (pc) {
      pc.close();
      delete _hostPCs[guestId];
    }
  }

  function stopScreenShare() {
    /* stop all tracks */
    if (_hostStream) {
      _hostStream.getTracks().forEach(function (t) { t.stop(); });
      _hostStream = null;
    }

    /* close all peer connections */
    Object.keys(_hostPCs).forEach(function (id) {
      try { _hostPCs[id].close(); } catch (_) {}
    });
    _hostPCs = {};

    /* reset UI */
    setVideoStream(null);
    showEl('ss-host-prompt');

    /* notify room */
    if (_socket && _roomId) {
      _socket.emit('ss_stopped', { roomId: _roomId });
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     GUEST SIDE
     ═══════════════════════════════════════════════════════════════════════════ */

  function _receiveOffer(offer) {
    /* close any previous connection */
    if (_guestPC) {
      _guestPC.close();
      _guestPC = null;
    }

    _guestPC = makePeerConnection();

    _guestPC.ontrack = function (evt) {
      if (evt.streams && evt.streams[0]) {
        setVideoStream(evt.streams[0]);
        hideEl('ss-guest-prompt');
      }
    };

    _guestPC.onicecandidate = function (evt) {
      if (evt.candidate) {
        _socket.emit('ss_ice', {
          roomId:    _roomId,
          candidate: evt.candidate.toJSON(),
          /* no 'to' -> server broadcasts to room, host picks it up */
        });
      }
    };

    _guestPC.onconnectionstatechange = function () {
      var state = _guestPC ? _guestPC.connectionState : '';
      if (state === 'failed' || state === 'disconnected') {
        toast('Screen share connection lost.');
        _resetGuestView();
      }
    };

    _guestPC.setRemoteDescription(new RTCSessionDescription(offer))
      .then(function () { return _guestPC.createAnswer(); })
      .then(function (answer) {
        return _guestPC.setLocalDescription(answer).then(function () {
          _socket.emit('ss_answer', {
            roomId: _roomId,
            answer: _guestPC.localDescription,
          });
        });
      })
      .catch(function (err) {
        toast('Failed to connect to screen share: ' + err.message);
        console.error('[ScreenShare] guest answer error:', err);
        _resetGuestView();
      });
  }

  function _handleGuestIce(candidate) {
    if (!_guestPC) return;
    _guestPC.addIceCandidate(new RTCIceCandidate(candidate)).catch(function (err) {
      console.warn('[ScreenShare] addIceCandidate (guest) error:', err.message);
    });
  }

  function _resetGuestView() {
    if (_guestPC) {
      _guestPC.close();
      _guestPC = null;
    }
    setVideoStream(null);
    showEl('ss-guest-prompt');
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     SOCKET LISTENER SETUP
     All ss_ socket events are registered here so app.js needs zero ss_ code.
     ═══════════════════════════════════════════════════════════════════════════ */

  function _registerSocketListeners() {
    /* ss_offer — server sends to guests when host starts sharing */
    _socket.on('ss_offer', function (data) {
      if (_isHost) return; /* host never processes its own offer */
      if (!data || !data.offer) return;
      _receiveOffer(data.offer);
    });

    /* ss_answer — server sends to host when a guest answers */
    _socket.on('ss_answer', function (data) {
      if (!_isHost) return;
      if (!data || !data.answer) return;
      _handleAnswerFromGuest(data.answer, data.from);
    });

    /* ss_ice — bidirectional ICE candidate relay */
    _socket.on('ss_ice', function (data) {
      if (!data || !data.candidate) return;
      if (_isHost) {
        _handleHostIce(data.candidate, data.from);
      } else {
        _handleGuestIce(data.candidate);
      }
    });

    /* ss_stopped — host stopped sharing */
    _socket.on('ss_stopped', function () {
      if (_isHost) return;
      _resetGuestView();
      toast('Host stopped screen sharing.');
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     HOST UI WIRING
     Binds the "Start Screen Share" button.
     ═══════════════════════════════════════════════════════════════════════════ */

  function _wireHostUI() {
    var startBtn = el('ss-start-btn');
    if (!startBtn) return;

    /* show unavailable message immediately if environment is bad,
       so user sees a useful error before even clicking */
    if (!isSupported() || !isSecureOrigin()) {
      showUnavailableError();
      return;
    }

    /* show the prompt panel — it starts as display:none in HTML */
    showEl('ss-host-prompt');

    startBtn.addEventListener('click', function () {
      startScreenShare();
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     PUBLIC API
     ═══════════════════════════════════════════════════════════════════════════ */

  /*
    ScreenShare.init(socket, roomId, isHost)
    Call once after joining the room, when the screenshare panel is shown.
    This registers all socket listeners and wires the host UI button.
  */
  function init(socket, roomId, isHost) {
    _socket  = socket;
    _roomId  = roomId;
    _isHost  = !!isHost;

    _registerSocketListeners();

    if (_isHost) {
      _wireHostUI();
    } else {
      /* show waiting prompt for guest */
      showEl('ss-guest-prompt');
    }
  }

  /* Expose minimal surface — app.js only needs init() and stop() */
  window.ScreenShare = {
    init:      init,
    stop:      stopScreenShare,
    supported: isSupported,
  };

}());
