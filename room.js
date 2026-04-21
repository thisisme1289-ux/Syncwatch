// room.js - socket connection, room state, UI sync

const Room = (() => {
  let socket = null;
  let state = {
    roomId: null, code: null, mode: null, isHost: false,
    mySocketId: null, nickname: null, hostToken: null,
    settings: {}, users: [], playback: {},
  };

  function getState() { return state; }
  function getSocket() { return socket; }

  function join({ roomId, nickname, password, hostToken }) {
    return new Promise((resolve, reject) => {
      socket = io({ transports: ['websocket'], upgrade: false });

      socket.on('connect', () => {
        state.nickname = nickname;
        state.hostToken = hostToken || null;
        socket.emit('join_room', { roomId, nickname, password, hostToken });
      });

      socket.on('room_joined', data => {
        Object.assign(state, data);
        setupEventHandlers();
        resolve(data);
      });

      socket.on('room_error', data => {
        reject(new Error(data.message));
        socket.disconnect();
      });

      socket.on('connect_error', () => reject(new Error('Connection failed')));
    });
  }

  function setupEventHandlers() {
    socket.on('user_joined', data => {
      if (!state.users.find(u => u.socketId === data.socketId)) state.users.push(data);
      renderUserList();
      addSystemMessage(data.nickname + ' joined');
      DataCounter.countSocketEvent('user_joined', data);
    });

    socket.on('user_left', data => {
      state.users = state.users.filter(u => u.socketId !== data.socketId);
      renderUserList();
      addSystemMessage(data.nickname + ' left');
    });

    socket.on('host_transferred', data => {
      state.users = state.users.map(u => ({ ...u, isHost: u.socketId === data.newHostId }));
      if (data.newHostId === state.mySocketId) {
        state.isHost = true;
        toggleHostUI(true);
        Utils.toast('You are now the host');
      }
      renderUserList();
      addSystemMessage(data.newHostNickname + ' is now the host');
    });

    socket.on('playback_play', ({ timestamp, by }) => {
      DataCounter.countSocketEvent('playback_play', { timestamp });
      Player.handleRemotePlay(timestamp);
      if (by !== state.nickname) Utils.toast(by + ' pressed play');
    });

    socket.on('playback_pause', ({ timestamp, by }) => {
      DataCounter.countSocketEvent('playback_pause', { timestamp });
      Player.handleRemotePause(timestamp);
      if (by !== state.nickname) Utils.toast(by + ' paused');
    });

    socket.on('playback_seek', ({ timestamp, by }) => {
      DataCounter.countSocketEvent('playback_seek', { timestamp });
      Player.handleRemoteSeek(timestamp);
      if (by !== state.nickname) Utils.toast(by + ' seeked to ' + Utils.formatTime(timestamp));
    });

    socket.on('playback_rate', ({ rate, by }) => {
      Player.handleRemoteRate(rate);
      if (by !== state.nickname) Utils.toast(by + ' set speed to ' + rate + 'x');
    });


    socket.on('quality_change', ({ quality, by }) => {
      if (by !== state.nickname) Utils.toast(by + ' changed quality to ' + quality);
    });

    socket.on('sync_state', ({ playback }) => {
      Player.applySync(playback);
    });

    socket.on('chat_message', msg => {
      DataCounter.countSocketEvent('chat_message', msg);
      renderChatMessage(msg);
    });

    socket.on('settings_update', ({ settings }) => {
      state.settings = settings;
      applySettings(settings);
      Player.updateCanControl(settings, state.isHost);
      if (state.isHost) syncSettingsUI(settings);
    });

    socket.on('disconnect', () => {
      addSystemMessage('Disconnected from server');
    });
  }

  // Emit helpers
  function emit(event, data) {
    if (!socket) return;
    DataCounter.countSocketEvent(event, data);
    socket.emit(event, { roomId: state.roomId, ...data });
  }

  function emitPlay(timestamp)    { emit('playback_play',  { timestamp }); }
  function emitPause(timestamp)   { emit('playback_pause', { timestamp }); }
  function emitSeek(timestamp)    { emit('playback_seek',  { timestamp }); }
  function emitRate(rate)         { emit('playback_rate',  { rate }); }
  function emitChat(text)         { emit('chat_message',   { text }); }
  function requestSync()          { emit('request_sync',   {}); }
  function emitQualityChange(q)   { emit('quality_change', { quality: q }); }

  function emitSettingsUpdate(settings) {
    state.settings = { ...state.settings, ...settings };
    emit('settings_update', { settings });
  }

  // UI
  function renderUserList() {
    const list = document.getElementById('user-list');
    if (!list) return;
    list.innerHTML = '';
    state.users.forEach(u => {
      const li = document.createElement('li');
      if (u.isHost) li.classList.add('is-host');
      li.innerHTML =
        '<span class="dot"></span>' +
        '<span class="user-nick">' + escHtml(u.nickname) + '</span>' +
        (u.isHost ? '<span class="host-badge">host</span>' : '');
      list.appendChild(li);
    });
  }

  function renderChatMessage({ nickname, text }) {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.innerHTML = '<span class="chat-nick">' + escHtml(nickname) + '</span><span class="chat-text">' + escHtml(text) + '</span>';
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function addSystemMessage(text) {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    const div = document.createElement('div');
    div.className = 'chat-msg system';
    div.innerHTML = '<span class="chat-text">' + escHtml(text) + '</span>';
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  function applySettings(settings) {
    const chatSection = document.getElementById('chat-section');
    if (chatSection) chatSection.style.display = settings.chatEnabled ? '' : 'none';
  }

  function syncSettingsUI(settings) {
    const ids = {
      'setting-host-only': 'hostOnlyControl',
      'setting-chat': 'chatEnabled',
      'setting-voice': 'voiceEnabled',
      'setting-datasaver': 'dataSaver',
    };
    Object.entries(ids).forEach(([elId, key]) => {
      const el = document.getElementById(elId);
      if (el) el.checked = !!settings[key];
    });
  }

  function toggleHostUI(show) {
    const p = document.getElementById('host-panel');
    if (p) p.style.display = show ? '' : 'none';
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function leave() {
    if (socket) socket.disconnect();
    socket = null;
    state = { roomId: null, code: null, mode: null, isHost: false, mySocketId: null, nickname: null, hostToken: null, settings: {}, users: [], playback: {} };
  }

  return {
    join, leave, getState, getSocket,
    emitPlay, emitPause, emitSeek, emitRate, emitChat, requestSync,
    emitSettingsUpdate, emitQualityChange,
    renderUserList, renderChatMessage, addSystemMessage,
    applySettings, syncSettingsUI, toggleHostUI,
  };
})();
