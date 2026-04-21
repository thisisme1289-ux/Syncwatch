/*
  app.js — SyncWatch main orchestrator
  Handles: page routing, room create/join, socket wiring,
           mode init (local / upload / screenshare), chat,
           user list, host settings, data meter.
  Dependencies (loaded before this file in index.html):
    socket.io.js, utils.js, datacounter.js, room.js,
    player.js, screenshare.js
*/

document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  /* ── in-memory state (never localStorage) ───────────────────────────────── */
  var state = {
    socket:      null,
    roomId:      null,
    roomCode:    null,
    roomMode:    null,
    isHost:      false,
    hostToken:   null,
    nickname:    null,
    mySocketId:  null,
    settings:    {},
  };

  /* ── escape helper (guards chat / nicknames against XSS) ───────────────── */
  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── safe DOM getter ────────────────────────────────────────────────────── */
  function el(id) { return document.getElementById(id); }

  /* ── toast wrapper (utils.js provides showToast) ───────────────────────── */
  function toast(msg) {
    if (typeof showToast === 'function') showToast(msg);
    else console.warn('[app]', msg);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     PAGE ROUTING
     ══════════════════════════════════════════════════════════════════════════ */

  function showPage(tplId) {
    var app = el('app');
    if (!app) return;
    app.innerHTML = '';
    var tpl = el(tplId);
    if (!tpl) { console.error('Template not found:', tplId); return; }
    app.appendChild(document.importNode(tpl.content, true));
  }

  /* ══════════════════════════════════════════════════════════════════════════
     HOME PAGE
     ══════════════════════════════════════════════════════════════════════════ */

  function initHomePage() {
    showPage('tpl-home');

    /* ── mode selector ───────────────────────────────────────────────────── */
    var selectedMode = 'local';
    el('app').querySelectorAll('.mode-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        el('app').querySelectorAll('.mode-btn').forEach(function (b) {
          b.classList.remove('active');
        });
        btn.classList.add('active');
        selectedMode = btn.dataset.mode;
      });
    });

    /* ── check URL for pre-filled room code ─────────────────────────────── */
    var params = new URLSearchParams(window.location.search);
    var codeParam = params.get('code') || params.get('room') || '';
    if (codeParam) {
      var codeInput = el('room-code-input');
      if (codeInput) codeInput.value = codeParam.toUpperCase();
    }

    /* ── create room ─────────────────────────────────────────────────────── */
    var createBtn = el('create-room-btn');
    if (createBtn) {
      createBtn.addEventListener('click', function () {
        var nickname = (el('host-nickname').value || '').trim();
        var password = (el('room-password').value || '').trim();
        if (!nickname) { toast('Please enter a nickname.'); return; }

        createBtn.disabled = true;
        createBtn.textContent = 'Creating...';

        fetch('/api/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nickname: nickname,
            mode:     selectedMode,
            password: password || undefined,
            settings: {
              hostOnlyControl: true,
              chatEnabled:     true,
              voiceEnabled:    false,
              dataSaver:       true,
              defaultQuality:  'low',
            },
          }),
        })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || 'Server error'); });
          return r.json();
        })
        .then(function (data) {
          /* store host credentials in memory */
          state.hostToken = data.hostToken;
          state.nickname  = nickname;
          /* connect and join */
          connectAndJoin(data.roomId, nickname, password, data.hostToken);
        })
        .catch(function (err) {
          toast('Could not create room: ' + err.message);
          createBtn.disabled = false;
          createBtn.textContent = 'Create Room';
        });
      });
    }

    /* ── join room ───────────────────────────────────────────────────────── */
    var joinBtn = el('join-room-btn');
    if (joinBtn) {
      /* look up room when code is entered (to show password field if needed) */
      var codeInput2 = el('room-code-input');
      if (codeInput2) {
        codeInput2.addEventListener('input', function () {
          var code = codeInput2.value.trim().toUpperCase();
          if (code.length === 6) lookupRoom(code);
        });
        /* also trigger if pre-filled from URL */
        if (codeInput2.value.length === 6) lookupRoom(codeInput2.value.trim().toUpperCase());
      }

      joinBtn.addEventListener('click', function () {
        var nickname = (el('guest-nickname').value || '').trim();
        var code     = ((el('room-code-input') || {}).value || '').trim().toUpperCase();
        var password = ((el('join-password') || {}).value || '').trim();
        if (!nickname) { toast('Please enter a nickname.'); return; }
        if (!code || code.length !== 6) { toast('Please enter a 6-character room code.'); return; }

        state.nickname = nickname;
        connectAndJoin(code, nickname, password, null);
      });
    }
  }

  function lookupRoom(code) {
    fetch('/api/rooms/' + code)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.hasPassword) {
          var pf = el('join-password-field');
          if (pf) pf.style.display = 'block';
        }
      })
      .catch(function () {});
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SOCKET — connect and join room
     ══════════════════════════════════════════════════════════════════════════ */

  function connectAndJoin(roomIdentifier, nickname, password, hostToken) {
    /* disconnect any existing socket first */
    if (state.socket) {
      state.socket.disconnect();
      state.socket = null;
    }

    var socket = io({
      transports: ['websocket'],
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });
    state.socket = socket;

    socket.on('connect', function () {
      socket.emit('join_room', {
        roomId:    roomIdentifier,
        nickname:  nickname,
        password:  password  || undefined,
        hostToken: hostToken || undefined,
      });
    });

    socket.on('room_error', function (data) {
      toast((data && data.message) ? data.message : 'Failed to join room.');
      socket.disconnect();
      state.socket = null;
      /* re-enable buttons if we came from home page */
      var createBtn = el('create-room-btn');
      var joinBtn   = el('join-room-btn');
      if (createBtn) { createBtn.disabled = false; createBtn.textContent = 'Create Room'; }
      if (joinBtn)   { joinBtn.disabled   = false; joinBtn.textContent   = 'Join Room'; }
    });

    socket.on('room_joined', function (data) {
      /* persist session state */
      state.roomId     = data.roomId;
      state.roomCode   = data.code;
      state.roomMode   = data.mode;
      state.isHost     = data.isHost;
      state.mySocketId = data.mySocketId;
      state.settings   = data.settings || {};

      /* update URL so user can share the link */
      history.replaceState({}, '', '/?code=' + data.code);

      /* render watch page */
      initWatchPage(data, socket);
    });

    socket.on('connect_error', function () {
      toast('Connection error. Retrying...');
    });

    socket.on('disconnect', function (reason) {
      if (reason === 'io server disconnect') {
        toast('Disconnected by server.');
        goHome();
      }
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     WATCH PAGE
     ══════════════════════════════════════════════════════════════════════════ */

  function initWatchPage(roomData, socket) {
    showPage('tpl-watch');

    /* ── sidebar info ────────────────────────────────────────────────────── */
    var nameEl = el('room-name-display');
    if (nameEl) nameEl.textContent = roomData.hostNickname || 'Room';

    var codeEl = el('room-code-badge');
    if (codeEl) {
      codeEl.textContent = roomData.code;
      codeEl.title = 'Click to copy room code';
      codeEl.addEventListener('click', function () {
        copyText(roomData.code);
        toast('Room code copied.');
      });
    }

    var modeEl = el('room-mode-badge');
    if (modeEl) modeEl.textContent = roomData.mode;

    /* ── initial user list ───────────────────────────────────────────────── */
    if (roomData.users) {
      roomData.users.forEach(function (u) { addUserToList(u.socketId, u.nickname, u.isHost); });
    }

    /* ── initial chat history ────────────────────────────────────────────── */
    if (roomData.chat) {
      roomData.chat.forEach(function (msg) { appendChatMessage(msg.nickname, msg.text, msg.ts); });
    }

    /* ── mode panels ─────────────────────────────────────────────────────── */
    var mode = roomData.mode;
    el('local-panel')       && (el('local-panel').style.display       = mode === 'local'       ? 'flex' : 'none');
    el('upload-panel')      && (el('upload-panel').style.display      = mode === 'upload'      ? 'flex' : 'none');
    el('screenshare-panel') && (el('screenshare-panel').style.display = mode === 'screenshare' ? 'flex' : 'none');

    /* ── host settings panel ─────────────────────────────────────────────── */
    var hostPanel = el('host-panel');
    if (hostPanel) hostPanel.style.display = state.isHost ? 'block' : 'none';

    /* ── apply initial settings ──────────────────────────────────────────── */
    applySettings(state.settings);

    /* ── sidebar toggle (mobile) ─────────────────────────────────────────── */
    initSidebarToggle();

    /* ── wire all UI ─────────────────────────────────────────────────────── */
    wireChat(socket);
    wireSidebarActions(socket);
    wireHostSettings(socket);
    wireDataMeter();

    /* ── init mode-specific behaviour ────────────────────────────────────── */
    if (mode === 'local') {
      initLocalMode(socket, roomData);
    } else if (mode === 'upload') {
      initUploadMode(socket, roomData);
    } else if (mode === 'screenshare') {
      initScreenshareMode(socket, roomData);
    }

    /* ── register all server->client socket events ───────────────────────── */
    registerSocketListeners(socket);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SERVER -> CLIENT SOCKET EVENTS
     ══════════════════════════════════════════════════════════════════════════ */

  function registerSocketListeners(socket) {

    /* ── user presence ───────────────────────────────────────────────────── */
    socket.on('user_joined', function (data) {
      addUserToList(data.socketId, data.nickname, data.isHost);
      appendSystemMessage(escHtml(data.nickname) + ' joined.');
    });

    socket.on('user_left', function (data) {
      removeUserFromList(data.socketId);
      appendSystemMessage(escHtml(data.nickname) + ' left.');
    });

    socket.on('host_transferred', function (data) {
      /* update isHost flag if this client is the new host */
      if (data.newHostId === state.mySocketId) {
        state.isHost = true;
        var hostPanel = el('host-panel');
        if (hostPanel) hostPanel.style.display = 'block';
        toast('You are now the host.');
      }
      /* refresh host badge in user list */
      updateHostBadge(data.newHostId);
      appendSystemMessage(escHtml(data.newHostNickname) + ' is now the host.');
    });

    /* ── playback events ─────────────────────────────────────────────────── */
    socket.on('playback_play', function (data) {
      if (typeof Player !== 'undefined' && Player.receivePlay) {
        Player.receivePlay(data.timestamp);
      }
      appendSystemMessage(escHtml(data.by || '') + ' pressed play.');
    });

    socket.on('playback_pause', function (data) {
      if (typeof Player !== 'undefined' && Player.receivePause) {
        Player.receivePause(data.timestamp);
      }
      appendSystemMessage(escHtml(data.by || '') + ' paused.');
    });

    socket.on('playback_seek', function (data) {
      if (typeof Player !== 'undefined' && Player.receiveSeek) {
        Player.receiveSeek(data.timestamp);
      }
    });

    socket.on('playback_rate', function (data) {
      if (typeof Player !== 'undefined' && Player.receiveRate) {
        Player.receiveRate(data.rate);
      }
      var sel = el('speed-select');
      if (sel) sel.value = String(data.rate);
    });

    socket.on('sync_state', function (data) {
      if (typeof Player !== 'undefined' && Player.receiveSync) {
        Player.receiveSync(data.playback);
      }
    });

    /* ── chat ────────────────────────────────────────────────────────────── */
    socket.on('chat_message', function (msg) {
      appendChatMessage(msg.nickname, msg.text, msg.ts);
    });

    /* ── settings ────────────────────────────────────────────────────────── */
    socket.on('settings_update', function (data) {
      state.settings = data.settings || state.settings;
      applySettings(state.settings);
    });

    /* ── upload mode: media ready ────────────────────────────────────────── */
    socket.on('media_ready', function (data) {
      if (state.roomMode !== 'upload' || state.isHost) return;
      var guestPrompt = el('upload-guest-prompt');
      var video       = el('upload-video');
      if (guestPrompt) guestPrompt.style.display = 'none';
      if (video && data.url) {
        video.src = data.url;
        video.style.display = 'block';
        if (typeof Player !== 'undefined' && Player.attachUploadVideo) {
          Player.attachUploadVideo(video, socket, state.roomId);
        }
        /* request current playback state so late joiner syncs up */
        socket.emit('request_sync', { roomId: state.roomId });
      }
      toast('Host started the video.');
    });

    /* quality_change is per-viewer only; no global handler needed */
  }

  /* ══════════════════════════════════════════════════════════════════════════
     MODE INITIALIZATION
     ══════════════════════════════════════════════════════════════════════════ */

  /* ── Local Sync mode ─────────────────────────────────────────────────────── */
  function initLocalMode(socket, roomData) {
    var loadBtn   = el('local-load-btn');
    var fileInput = el('local-file-input');
    var video     = el('local-video');
    var prompt    = el('local-prompt');

    if (!loadBtn || !fileInput || !video) return;

    loadBtn.addEventListener('click', function () { fileInput.click(); });

    fileInput.addEventListener('change', function () {
      var file = fileInput.files[0];
      if (!file) return;

      var url = URL.createObjectURL(file);
      video.src = url;
      video.style.display = 'block';
      if (prompt) prompt.style.display = 'none';

      if (typeof Player !== 'undefined' && Player.init) {
        Player.init({
          videoEl:  video,
          socket:   socket,
          roomId:   state.roomId,
          isHost:   state.isHost,
          playback: roomData.playback,
          settings: state.settings,
        });
      }

      /* sync with room on load */
      socket.emit('request_sync', { roomId: state.roomId });
    });

    /* wire playback bar */
    wirePlaybackBar(socket);
  }

  /* ── Upload mode ─────────────────────────────────────────────────────────── */
  function initUploadMode(socket, roomData) {
    var video = el('upload-video');

    if (state.isHost) {
      var hostPrompt  = el('upload-host-prompt');
      var uploadBtn   = el('upload-file-btn');
      var fileInput   = el('upload-file-input');
      var progressBox = el('upload-progress');
      var progressBar = el('progress-fill');
      var progressTxt = el('progress-text');

      if (hostPrompt) hostPrompt.style.display = 'flex';
      if (uploadBtn)  uploadBtn.addEventListener('click', function () { fileInput && fileInput.click(); });

      if (fileInput) {
        fileInput.addEventListener('change', function () {
          var file = fileInput.files[0];
          if (!file) return;

          var MAX_MB = 2048;
          if (file.size > MAX_MB * 1024 * 1024) {
            toast('File is too large. Max is ' + MAX_MB + ' MB.');
            return;
          }

          if (progressBox) progressBox.style.display = 'block';
          if (uploadBtn)   uploadBtn.disabled = true;

          var formData = new FormData();
          formData.append('video', file);
          formData.append('roomId', state.roomId);
          formData.append('hostToken', state.hostToken);

          var xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/upload', true);

          xhr.upload.onprogress = function (e) {
            if (e.lengthComputable) {
              var pct = Math.round((e.loaded / e.total) * 100);
              if (progressBar) progressBar.style.width = pct + '%';
              if (progressTxt) progressTxt.textContent = pct + '%';
            }
          };

          xhr.onload = function () {
            if (xhr.status === 200) {
              var resp = JSON.parse(xhr.responseText);
              if (hostPrompt) hostPrompt.style.display = 'none';
              if (video) {
                video.src = resp.url;
                video.style.display = 'block';
                if (typeof Player !== 'undefined' && Player.init) {
                  Player.init({
                    videoEl:  video,
                    socket:   socket,
                    roomId:   state.roomId,
                    isHost:   state.isHost,
                    playback: roomData.playback,
                    settings: state.settings,
                  });
                }
              }
              wirePlaybackBar(socket);
            } else {
              toast('Upload failed.');
              if (uploadBtn) uploadBtn.disabled = false;
              if (progressBox) progressBox.style.display = 'none';
            }
          };

          xhr.onerror = function () {
            toast('Upload error. Check your connection.');
            if (uploadBtn) uploadBtn.disabled = false;
            if (progressBox) progressBox.style.display = 'none';
          };

          xhr.send(formData);
        });
      }

    } else {
      /* guest: show waiting prompt; actual video load happens in media_ready handler */
      var guestPrompt = el('upload-guest-prompt');
      if (guestPrompt) guestPrompt.style.display = 'flex';

      /* if media already exists when guest joins (late joiner) */
      if (roomData.media && roomData.media.url) {
        if (guestPrompt) guestPrompt.style.display = 'none';
        if (video) {
          video.src = roomData.media.url;
          video.style.display = 'block';
          if (typeof Player !== 'undefined' && Player.init) {
            Player.init({
              videoEl:  video,
              socket:   socket,
              roomId:   state.roomId,
              isHost:   state.isHost,
              playback: roomData.playback,
              settings: state.settings,
            });
          }
          wirePlaybackBar(socket);
          socket.emit('request_sync', { roomId: state.roomId });
        }
      }
    }
  }

  /* ── Screenshare mode ────────────────────────────────────────────────────── */
  function initScreenshareMode(socket, roomData) {
    /*
      ScreenShare.init() handles everything:
        - checks navigator.mediaDevices / secure context
        - shows error UI if unsupported
        - wires the Start button for host
        - registers ss_offer / ss_answer / ss_ice / ss_stopped listeners
    */
    if (typeof ScreenShare !== 'undefined' && ScreenShare.init) {
      ScreenShare.init(socket, state.roomId, state.isHost);
    } else {
      console.error('[app] screenshare.js not loaded');
    }

    /* screenshare has no Player-based playback bar; hide it */
    var bar = el('playback-bar');
    if (bar) bar.style.display = 'none';
  }

  /* ══════════════════════════════════════════════════════════════════════════
     PLAYBACK BAR
     ══════════════════════════════════════════════════════════════════════════ */

  function wirePlaybackBar(socket) {
    var playPauseBtn = el('play-pause-btn');
    var progressTrack = el('progress-track');
    var speedSelect  = el('speed-select');
    var fullscreenBtn = el('fullscreen-btn');
    var qualitySelect = el('quality-select');

    if (playPauseBtn) {
      playPauseBtn.addEventListener('click', function () {
        if (typeof Player !== 'undefined' && Player.togglePlayPause) {
          Player.togglePlayPause();
        }
      });
    }

    if (progressTrack) {
      progressTrack.addEventListener('click', function (e) {
        var rect = progressTrack.getBoundingClientRect();
        var pct  = (e.clientX - rect.left) / rect.width;
        if (typeof Player !== 'undefined' && Player.seekTo) {
          Player.seekTo(pct);
        }
      });
    }

    if (speedSelect) {
      speedSelect.addEventListener('change', function () {
        var rate = parseFloat(speedSelect.value);
        if (typeof Player !== 'undefined' && Player.setRate) {
          Player.setRate(rate, socket, state.roomId);
        }
      });
    }

    if (qualitySelect) {
      qualitySelect.addEventListener('change', function () {
        socket.emit('quality_change', {
          roomId:  state.roomId,
          quality: qualitySelect.value,
        });
      });
    }

    if (fullscreenBtn) {
      fullscreenBtn.addEventListener('click', function () {
        var container = el('video-container');
        if (!container) return;
        if (!document.fullscreenElement) {
          container.requestFullscreen && container.requestFullscreen();
          fullscreenBtn.textContent = 'Compress';
        } else {
          document.exitFullscreen && document.exitFullscreen();
          fullscreenBtn.textContent = 'Expand';
        }
      });
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     CHAT
     ══════════════════════════════════════════════════════════════════════════ */

  function wireChat(socket) {
    var input   = el('chat-input');
    var sendBtn = el('chat-send-btn');

    function sendChat() {
      if (!input) return;
      var text = input.value.trim();
      if (!text) return;
      if (!state.settings.chatEnabled) { toast('Chat is disabled by the host.'); return; }
      socket.emit('chat_message', { roomId: state.roomId, text: text });
      input.value = '';
    }

    if (sendBtn) sendBtn.addEventListener('click', sendChat);
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') sendChat();
      });
    }
  }

  function appendChatMessage(nickname, text, ts) {
    var box = el('chat-messages');
    if (!box) return;
    var div  = document.createElement('div');
    div.className = 'chat-msg';
    var time = ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    div.innerHTML =
      '<span class="chat-nick">' + escHtml(nickname) + '</span>' +
      '<span class="chat-text">' + escHtml(text) + '</span>' +
      (time ? '<span class="chat-time"> ' + time + '</span>' : '');
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function appendSystemMessage(html) {
    var box = el('chat-messages');
    if (!box) return;
    var div = document.createElement('div');
    div.className = 'chat-msg system';
    div.innerHTML = '<span class="chat-text">' + html + '</span>';
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     USER LIST
     ══════════════════════════════════════════════════════════════════════════ */

  function addUserToList(socketId, nickname, isHost) {
    var list = el('user-list');
    if (!list) return;
    /* avoid duplicates */
    if (list.querySelector('[data-sid="' + socketId + '"]')) return;

    var li = document.createElement('li');
    li.dataset.sid = socketId;
    if (isHost) li.classList.add('is-host');
    li.innerHTML =
      '<span class="dot"></span>' +
      '<span class="user-nick">' + escHtml(nickname) + '</span>' +
      (isHost ? '<span class="host-badge">host</span>' : '');
    list.appendChild(li);
  }

  function removeUserFromList(socketId) {
    var list = el('user-list');
    if (!list) return;
    var li = list.querySelector('[data-sid="' + socketId + '"]');
    if (li) li.remove();
  }

  function updateHostBadge(newHostSocketId) {
    var list = el('user-list');
    if (!list) return;
    /* clear all existing host badges */
    list.querySelectorAll('li').forEach(function (li) {
      li.classList.remove('is-host');
      var badge = li.querySelector('.host-badge');
      if (badge) badge.remove();
    });
    /* mark new host */
    var newLi = list.querySelector('[data-sid="' + newHostSocketId + '"]');
    if (newLi) {
      newLi.classList.add('is-host');
      newLi.innerHTML += '<span class="host-badge">host</span>';
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     HOST SETTINGS
     ══════════════════════════════════════════════════════════════════════════ */

  function wireHostSettings(socket) {
    var settingsBtn = el('settings-toggle-btn');
    var hostPanel   = el('host-panel');

    if (settingsBtn && hostPanel) {
      settingsBtn.addEventListener('click', function () {
        var visible = hostPanel.style.display !== 'none';
        hostPanel.style.display = visible ? 'none' : 'block';
      });
    }

    function emitSettings() {
      if (!state.isHost) return;
      var updated = {
        hostOnlyControl: el('setting-host-only') ? el('setting-host-only').checked : state.settings.hostOnlyControl,
        chatEnabled:     el('setting-chat')      ? el('setting-chat').checked      : state.settings.chatEnabled,
        voiceEnabled:    el('setting-voice')     ? el('setting-voice').checked     : state.settings.voiceEnabled,
        dataSaver:       el('setting-datasaver') ? el('setting-datasaver').checked : state.settings.dataSaver,
      };
      socket.emit('settings_update', { roomId: state.roomId, settings: updated });
    }

    ['setting-host-only', 'setting-chat', 'setting-voice', 'setting-datasaver'].forEach(function (id) {
      var input = el(id);
      if (input) input.addEventListener('change', emitSettings);
    });
  }

  function applySettings(settings) {
    /* sync checkbox states */
    if (el('setting-host-only')) el('setting-host-only').checked = !!settings.hostOnlyControl;
    if (el('setting-chat'))      el('setting-chat').checked      = !!settings.chatEnabled;
    if (el('setting-voice'))     el('setting-voice').checked     = !!settings.voiceEnabled;
    if (el('setting-datasaver')) el('setting-datasaver').checked = !!settings.dataSaver;

    /* show/hide chat input based on setting */
    var chatSection = el('chat-section');
    if (chatSection) chatSection.style.display = settings.chatEnabled ? 'flex' : 'none';
  }

  /* ══════════════════════════════════════════════════════════════════════════
     DATA METER
     ══════════════════════════════════════════════════════════════════════════ */

  function wireDataMeter() {
    if (typeof DataCounter === 'undefined') return;
    var valueEl = el('data-value');
    if (!valueEl) return;
    DataCounter.start(function (bytes) {
      if (bytes < 1024) {
        valueEl.textContent = bytes + ' B';
      } else if (bytes < 1024 * 1024) {
        valueEl.textContent = (bytes / 1024).toFixed(1) + ' KB';
      } else {
        valueEl.textContent = (bytes / (1024 * 1024)).toFixed(2) + ' MB';
      }
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SIDEBAR ACTIONS
     ══════════════════════════════════════════════════════════════════════════ */

  function wireSidebarActions(socket) {
    var copyBtn  = el('copy-link-btn');
    var leaveBtn = el('leave-room-btn');

    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var link = window.location.origin + '/?code=' + state.roomCode;
        if (typeof copyText === 'function') copyText(link);
        else navigator.clipboard && navigator.clipboard.writeText(link);
        toast('Invite link copied.');
      });
    }

    if (leaveBtn) {
      leaveBtn.addEventListener('click', function () {
        leaveRoom(socket);
      });
    }
  }

  function leaveRoom(socket) {
    /* clean up screenshare if active */
    if (typeof ScreenShare !== 'undefined' && ScreenShare.stop) {
      ScreenShare.stop();
    }
    /* stop data counter */
    if (typeof DataCounter !== 'undefined' && DataCounter.stop) {
      DataCounter.stop();
    }
    /* disconnect socket */
    if (socket) socket.disconnect();
    state.socket   = null;
    state.roomId   = null;
    state.roomCode = null;
    state.isHost   = false;
    state.hostToken = null;

    /* clear invite code from URL */
    history.replaceState({}, '', '/');

    goHome();
  }

  function goHome() {
    initHomePage();
  }

  /* ══════════════════════════════════════════════════════════════════════════
     MOBILE SIDEBAR TOGGLE
     ══════════════════════════════════════════════════════════════════════════ */

  function initSidebarToggle() {
    var toggleBtn = el('sidebar-toggle');
    var overlay   = el('sidebar-overlay');
    var sidebar   = el('sidebar');
    if (!toggleBtn || !overlay || !sidebar) return;

    function openSidebar() {
      sidebar.classList.add('open');
      overlay.classList.add('active');
      toggleBtn.setAttribute('aria-expanded', 'true');
    }
    function closeSidebar() {
      sidebar.classList.remove('open');
      overlay.classList.remove('active');
      toggleBtn.setAttribute('aria-expanded', 'false');
    }

    toggleBtn.addEventListener('click', function () {
      sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
    });
    overlay.addEventListener('click', closeSidebar);

    var chatSend = el('chat-send-btn');
    if (chatSend) {
      chatSend.addEventListener('click', function () {
        if (window.innerWidth <= 640) closeSidebar();
      });
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     BOOT
     ══════════════════════════════════════════════════════════════════════════ */

  /*
    If the URL already has a room code (e.g. user followed an invite link),
    pre-populate the join form and scroll to it.
  */
  initHomePage();

  var params = new URLSearchParams(window.location.search);
  var inviteCode = params.get('code') || params.get('room');
  if (inviteCode) {
    /* scroll join card into view after home page renders */
    setTimeout(function () {
      var joinCard = el('join-card');
      if (joinCard) joinCard.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }

});
