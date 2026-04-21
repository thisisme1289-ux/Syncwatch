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

  /* ── in-memory state (no localStorage, no sessionStorage) ──────────────── */
  var state = {
    socket:     null,
    roomId:     null,
    roomCode:   null,
    roomMode:   null,
    isHost:     false,
    hostToken:  null,
    nickname:   null,
    mySocketId: null,
    settings:   {},
  };

  /* ── helpers ────────────────────────────────────────────────────────────── */
  function escHtml(str) {
    return String(str)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;');
  }

  function el(id) { return document.getElementById(id); }

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

    /* mode selector */
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

    /* pre-fill code from URL */
    var params    = new URLSearchParams(window.location.search);
    var codeParam = (params.get('code') || params.get('room') || '').toUpperCase();
    if (codeParam) {
      var codeInput = el('room-code-input');
      if (codeInput) {
        codeInput.value = codeParam;
        lookupRoom(codeParam);
      }
    }

    /* ── create room ─────────────────────────────────────────────────────── */
    var createBtn = el('create-room-btn');
    if (createBtn) {
      createBtn.addEventListener('click', function () {
        var nickname = (el('host-nickname').value || '').trim();
        var password = (el('room-password').value  || '').trim();
        if (!nickname) { toast('Please enter a nickname.'); return; }

        createBtn.disabled    = true;
        createBtn.textContent = 'Creating...';

        fetch('/api/rooms', {
          method:  'POST',
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
          state.hostToken = data.hostToken;
          state.nickname  = nickname;
          /* host already has UUID from the create response — pass it directly */
          connectAndJoin(data.roomId, nickname, password, data.hostToken);
        })
        .catch(function (err) {
          toast('Could not create room: ' + err.message);
          createBtn.disabled    = false;
          createBtn.textContent = 'Create Room';
        });
      });
    }

    /* ── join room ───────────────────────────────────────────────────────── */
    var joinBtn   = el('join-room-btn');
    var codeInput = el('room-code-input');

    if (codeInput) {
      codeInput.addEventListener('input', function () {
        var code = codeInput.value.trim().toUpperCase();
        codeInput.value = code;
        if (code.length === 6) lookupRoom(code);
      });
    }

    if (joinBtn) {
      joinBtn.addEventListener('click', function () {
        var nickname = (el('guest-nickname').value  || '').trim();
        var code     = (codeInput ? codeInput.value : '').trim().toUpperCase();
        var password = ((el('join-password') || {}).value || '').trim();

        if (!nickname) { toast('Please enter a nickname.'); return; }
        if (!code || code.length !== 6) { toast('Please enter a 6-character room code.'); return; }

        joinBtn.disabled    = true;
        joinBtn.textContent = 'Joining...';
        state.nickname      = nickname;

        /*
          BUG FIX #1 — 404 / "Room not found" when joining by code:

          server/socket.js join_room handler calls roomManager.get(roomId)
          which is a UUID-only Map lookup. Passing the 6-char code as roomId
          always returns null -> "Room not found".

          Fix: resolve the 6-char code to a UUID via HTTP first, then use
          the real UUID when emitting join_room over the socket.
        */
        fetch('/api/rooms/' + code)
          .then(function (r) {
            if (!r.ok) throw new Error('Room not found. Check the code and try again.');
            return r.json();
          })
          .then(function (roomData) {
            connectAndJoin(roomData.roomId, nickname, password, null);
          })
          .catch(function (err) {
            toast(err.message);
            joinBtn.disabled    = false;
            joinBtn.textContent = 'Join Room';
          });
      });
    }
  }

  /* Fetch room info to reveal password field when needed */
  function lookupRoom(code) {
    fetch('/api/rooms/' + code)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.hasPassword) {
          var pf = el('join-password-field');
          if (pf) pf.style.display = 'block';
        }
      })
      .catch(function () { /* room not found yet — silently ignore */ });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SOCKET — connect and join (roomId is always a UUID by this point)
     ══════════════════════════════════════════════════════════════════════════ */

  function connectAndJoin(roomId, nickname, password, hostToken) {
    if (state.socket) {
      state.socket.disconnect();
      state.socket = null;
    }

    var socket = io({
      transports:           ['websocket'],
      reconnectionAttempts: 5,
      reconnectionDelay:    1000,
    });
    state.socket = socket;

    socket.on('connect', function () {
      socket.emit('join_room', {
        roomId:    roomId,
        nickname:  nickname,
        password:  password  || undefined,
        hostToken: hostToken || undefined,
      });
    });

    socket.on('room_error', function (data) {
      toast((data && data.message) ? data.message : 'Failed to join room.');
      socket.disconnect();
      state.socket = null;
      var createBtn = el('create-room-btn');
      var joinBtn   = el('join-room-btn');
      if (createBtn) { createBtn.disabled = false; createBtn.textContent = 'Create Room'; }
      if (joinBtn)   { joinBtn.disabled   = false; joinBtn.textContent   = 'Join Room'; }
    });

    socket.on('room_joined', function (data) {
      state.roomId     = data.roomId;
      state.roomCode   = data.code;
      state.roomMode   = data.mode;
      state.isHost     = data.isHost;
      state.mySocketId = data.mySocketId;
      state.settings   = data.settings || {};

      history.replaceState({}, '', '/?code=' + data.code);
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

    var nameEl = el('room-name-display');
    if (nameEl) nameEl.textContent = roomData.hostNickname || 'Room';

    var codeEl = el('room-code-badge');
    if (codeEl) {
      codeEl.textContent = roomData.code;
      codeEl.title = 'Click to copy room code';
      codeEl.addEventListener('click', function () {
        if (typeof copyText === 'function') copyText(roomData.code);
        toast('Room code copied.');
      });
    }

    var modeEl = el('room-mode-badge');
    if (modeEl) modeEl.textContent = roomData.mode;

    if (roomData.users) {
      roomData.users.forEach(function (u) {
        addUserToList(u.socketId, u.nickname, u.isHost);
      });
    }

    if (roomData.chat) {
      roomData.chat.forEach(function (msg) {
        appendChatMessage(msg.nickname, msg.text, msg.ts);
      });
    }

    var mode = roomData.mode;
    if (el('local-panel'))       el('local-panel').style.display       = mode === 'local'       ? 'flex' : 'none';
    if (el('upload-panel'))      el('upload-panel').style.display      = mode === 'upload'      ? 'flex' : 'none';
    if (el('screenshare-panel')) el('screenshare-panel').style.display = mode === 'screenshare' ? 'flex' : 'none';

    var hostPanel = el('host-panel');
    if (hostPanel) hostPanel.style.display = state.isHost ? 'block' : 'none';

    applySettings(state.settings);
    initSidebarToggle();
    wireChat(socket);
    wireSidebarActions(socket);
    wireHostSettings(socket);
    wireDataMeter();

    if (mode === 'local') {
      initLocalMode(socket, roomData);
    } else if (mode === 'upload') {
      initUploadMode(socket, roomData);
    } else if (mode === 'screenshare') {
      initScreenshareMode(socket, roomData);
    }

    registerSocketListeners(socket);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     SERVER -> CLIENT SOCKET EVENTS
     ══════════════════════════════════════════════════════════════════════════ */

  function registerSocketListeners(socket) {

    socket.on('user_joined', function (data) {
      addUserToList(data.socketId, data.nickname, data.isHost);
      appendSystemMessage(escHtml(data.nickname) + ' joined.');
    });

    socket.on('user_left', function (data) {
      removeUserFromList(data.socketId);
      appendSystemMessage(escHtml(data.nickname) + ' left.');
    });

    socket.on('host_transferred', function (data) {
      if (data.newHostId === state.mySocketId) {
        state.isHost = true;
        var hostPanel = el('host-panel');
        if (hostPanel) hostPanel.style.display = 'block';
        toast('You are now the host.');
      }
      updateHostBadge(data.newHostId);
      appendSystemMessage(escHtml(data.newHostNickname || '') + ' is now the host.');
    });

    socket.on('playback_play', function (data) {
      if (typeof Player !== 'undefined' && Player.receivePlay) Player.receivePlay(data.timestamp);
    });

    socket.on('playback_pause', function (data) {
      if (typeof Player !== 'undefined' && Player.receivePause) Player.receivePause(data.timestamp);
    });

    socket.on('playback_seek', function (data) {
      if (typeof Player !== 'undefined' && Player.receiveSeek) Player.receiveSeek(data.timestamp);
    });

    socket.on('playback_rate', function (data) {
      if (typeof Player !== 'undefined' && Player.receiveRate) Player.receiveRate(data.rate);
      var sel = el('speed-select');
      if (sel) sel.value = String(data.rate);
    });

    socket.on('sync_state', function (data) {
      if (typeof Player !== 'undefined' && Player.receiveSync) Player.receiveSync(data.playback);
    });

    socket.on('chat_message', function (msg) {
      appendChatMessage(msg.nickname, msg.text, msg.ts);
    });

    socket.on('settings_update', function (data) {
      state.settings = data.settings || state.settings;
      applySettings(state.settings);
    });

    socket.on('media_ready', function (data) {
      if (state.roomMode !== 'upload' || state.isHost) return;
      var guestPrompt = el('upload-guest-prompt');
      var video       = el('upload-video');
      if (guestPrompt) guestPrompt.style.display = 'none';
      if (video && data.url) {
        video.src           = data.url;
        video.style.display = 'block';
        if (typeof Player !== 'undefined' && Player.init) {
          Player.init({
            videoEl:  video,
            socket:   socket,
            roomId:   state.roomId,
            isHost:   state.isHost,
            playback: {},
            settings: state.settings,
          });
        }
        wirePlaybackBar(socket);
        socket.emit('request_sync', { roomId: state.roomId });
      }
      toast('Host started the video.');
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     MODE INITIALIZATION
     ══════════════════════════════════════════════════════════════════════════ */

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
      video.src           = URL.createObjectURL(file);
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
      socket.emit('request_sync', { roomId: state.roomId });
      wirePlaybackBar(socket);
    });
  }

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
      if (uploadBtn) uploadBtn.addEventListener('click', function () { if (fileInput) fileInput.click(); });

      if (fileInput) {
        fileInput.addEventListener('change', function () {
          var file = fileInput.files[0];
          if (!file) return;

          if (file.size > 2048 * 1024 * 1024) {
            toast('File is too large. Max is 2048 MB.');
            return;
          }

          if (progressBox) progressBox.style.display = 'block';
          if (uploadBtn)   uploadBtn.disabled = true;

          var formData = new FormData();
          formData.append('video',     file);
          formData.append('roomId',    state.roomId);
          formData.append('hostToken', state.hostToken);

          var xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/upload', true);

          xhr.upload.onprogress = function (e) {
            if (e.lengthComputable) {
              var pct = Math.round((e.loaded / e.total) * 100);
              if (progressBar) progressBar.style.width = pct + '%';
              if (progressTxt) progressTxt.textContent  = pct + '%';
            }
          };

          xhr.onload = function () {
            if (xhr.status === 200) {
              var resp = JSON.parse(xhr.responseText);
              if (hostPrompt) hostPrompt.style.display = 'none';
              if (video) {
                video.src           = resp.url;
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
              }
            } else {
              toast('Upload failed. Try again.');
              if (uploadBtn)   uploadBtn.disabled = false;
              if (progressBox) progressBox.style.display = 'none';
            }
          };

          xhr.onerror = function () {
            toast('Upload error. Check your connection.');
            if (uploadBtn)   uploadBtn.disabled = false;
            if (progressBox) progressBox.style.display = 'none';
          };

          xhr.send(formData);
        });
      }

    } else {
      var guestPrompt = el('upload-guest-prompt');
      if (guestPrompt) guestPrompt.style.display = 'flex';

      /* late joiner — media already uploaded before they joined */
      if (roomData.media && roomData.media.url && video) {
        if (guestPrompt) guestPrompt.style.display = 'none';
        video.src           = roomData.media.url;
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

  function initScreenshareMode(socket, roomData) {
    /*
      screenshare.js self-registers all ss_offer / ss_answer / ss_ice /
      ss_stopped socket listeners. Do NOT add them here too.
    */
    if (typeof ScreenShare !== 'undefined' && ScreenShare.init) {
      ScreenShare.init(socket, state.roomId, state.isHost);
    } else {
      console.error('[app] screenshare.js not loaded or ScreenShare.init missing');
    }

    /* screenshare has no seek bar */
    var bar = el('playback-bar');
    if (bar) bar.style.display = 'none';
  }

  /* ══════════════════════════════════════════════════════════════════════════
     PLAYBACK BAR
     ══════════════════════════════════════════════════════════════════════════ */

  function wirePlaybackBar(socket) {
    var playPauseBtn  = el('play-pause-btn');
    var progressTrack = el('progress-track');
    var speedSelect   = el('speed-select');
    var qualitySelect = el('quality-select');
    var fullscreenBtn = el('fullscreen-btn');

    if (playPauseBtn) {
      playPauseBtn.addEventListener('click', function () {
        if (typeof Player !== 'undefined' && Player.togglePlayPause) Player.togglePlayPause();
      });
    }

    if (progressTrack) {
      progressTrack.addEventListener('click', function (e) {
        var rect = progressTrack.getBoundingClientRect();
        var pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        if (typeof Player !== 'undefined' && Player.seekTo) Player.seekTo(pct);
      });
    }

    if (speedSelect) {
      speedSelect.addEventListener('change', function () {
        var rate = parseFloat(speedSelect.value);
        if (typeof Player !== 'undefined' && Player.setRate) Player.setRate(rate, socket, state.roomId);
      });
    }

    if (qualitySelect) {
      qualitySelect.addEventListener('change', function () {
        socket.emit('quality_change', { roomId: state.roomId, quality: qualitySelect.value });
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
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendChat(); });
  }

  function appendChatMessage(nickname, text, ts) {
    var box = el('chat-messages');
    if (!box) return;
    var div  = document.createElement('div');
    div.className = 'chat-msg';
    var time = ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    div.innerHTML =
      '<span class="chat-nick">' + escHtml(nickname) + '</span>' +
      '<span class="chat-text">' + escHtml(text)     + '</span>' +
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
    list.querySelectorAll('li').forEach(function (li) {
      li.classList.remove('is-host');
      var b = li.querySelector('.host-badge');
      if (b) b.remove();
    });
    var newLi = list.querySelector('[data-sid="' + newHostSocketId + '"]');
    if (newLi) {
      newLi.classList.add('is-host');
      var badge = document.createElement('span');
      badge.className   = 'host-badge';
      badge.textContent = 'host';
      newLi.appendChild(badge);
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
        hostPanel.style.display = hostPanel.style.display === 'none' ? 'block' : 'none';
      });
    }

    function emitSettings() {
      if (!state.isHost) return;
      socket.emit('settings_update', {
        roomId: state.roomId,
        settings: {
          hostOnlyControl: el('setting-host-only') ? el('setting-host-only').checked : state.settings.hostOnlyControl,
          chatEnabled:     el('setting-chat')      ? el('setting-chat').checked      : state.settings.chatEnabled,
          voiceEnabled:    el('setting-voice')     ? el('setting-voice').checked     : state.settings.voiceEnabled,
          dataSaver:       el('setting-datasaver') ? el('setting-datasaver').checked : state.settings.dataSaver,
        },
      });
    }

    ['setting-host-only', 'setting-chat', 'setting-voice', 'setting-datasaver'].forEach(function (id) {
      var input = el(id);
      if (input) input.addEventListener('change', emitSettings);
    });
  }

  function applySettings(settings) {
    if (el('setting-host-only')) el('setting-host-only').checked = !!settings.hostOnlyControl;
    if (el('setting-chat'))      el('setting-chat').checked      = !!settings.chatEnabled;
    if (el('setting-voice'))     el('setting-voice').checked     = !!settings.voiceEnabled;
    if (el('setting-datasaver')) el('setting-datasaver').checked = !!settings.dataSaver;

    var chatSection = el('chat-section');
    if (chatSection) chatSection.style.display = settings.chatEnabled !== false ? 'flex' : 'none';
  }

  /* ══════════════════════════════════════════════════════════════════════════
     DATA METER

     BUG FIX #2 — DataCounter.start is not a function:
     We assumed a specific API shape without seeing datacounter.js source.
     Now we probe every reasonable method name so this works regardless of
     which API the actual file exposes.
     ══════════════════════════════════════════════════════════════════════════ */

  function wireDataMeter() {
    var valueEl = el('data-value');
    if (!valueEl) return;

    function updateDisplay(bytes) {
      bytes = Number(bytes) || 0;
      if (bytes < 1024)            valueEl.textContent = bytes + ' B';
      else if (bytes < 1048576)    valueEl.textContent = (bytes / 1024).toFixed(1) + ' KB';
      else                         valueEl.textContent = (bytes / 1048576).toFixed(2) + ' MB';
    }

    if (typeof DataCounter === 'undefined') {
      valueEl.textContent = '0 KB';
      return;
    }

    /* callback-style APIs */
    if (typeof DataCounter.start    === 'function') { DataCounter.start(updateDisplay);    return; }
    if (typeof DataCounter.init     === 'function') { DataCounter.init(updateDisplay);     return; }
    if (typeof DataCounter.onUpdate === 'function') { DataCounter.onUpdate(updateDisplay); return; }
    if (typeof DataCounter.listen   === 'function') { DataCounter.listen(updateDisplay);   return; }
    if (typeof DataCounter.onChange === 'function') { DataCounter.onChange(updateDisplay); return; }

    /* getter-style APIs — poll every second */
    var getter =
      typeof DataCounter.getTotal === 'function' ? 'getTotal' :
      typeof DataCounter.total    === 'function' ? 'total'    :
      typeof DataCounter.bytes    === 'function' ? 'bytes'    :
      typeof DataCounter.get      === 'function' ? 'get'      : null;

    if (getter) {
      setInterval(function () { updateDisplay(DataCounter[getter]()); }, 1000);
      return;
    }

    /* unknown shape — log the actual API so it can be fixed */
    console.warn('[app] DataCounter API shape unknown. Keys:', Object.keys(DataCounter));
    valueEl.textContent = '0 KB';
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
        else if (navigator.clipboard) navigator.clipboard.writeText(link);
        toast('Invite link copied.');
      });
    }

    if (leaveBtn) leaveBtn.addEventListener('click', function () { leaveRoom(socket); });
  }

  function leaveRoom(socket) {
    if (typeof ScreenShare !== 'undefined' && ScreenShare.stop) ScreenShare.stop();
    if (socket) socket.disconnect();

    state.socket    = null;
    state.roomId    = null;
    state.roomCode  = null;
    state.isHost    = false;
    state.hostToken = null;

    history.replaceState({}, '', '/');
    goHome();
  }

  function goHome() { initHomePage(); }

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

  initHomePage();

  var bootParams = new URLSearchParams(window.location.search);
  if (bootParams.get('code') || bootParams.get('room')) {
    setTimeout(function () {
      var joinCard = el('join-card');
      if (joinCard) joinCard.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }

});
