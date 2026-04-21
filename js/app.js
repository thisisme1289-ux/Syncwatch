// app.js - main controller

document.addEventListener('DOMContentLoaded', () => {

  const appEl = document.getElementById('app');

  function route() {
    const path = location.pathname;
    const joinMatch = path.match(/^\/join\/([a-zA-Z0-9-]+)$/);
    if (joinMatch) {
      showHomePage({ prefillId: joinMatch[1] });
    } else {
      showHomePage({});
    }
  }

  function render(templateId) {
    const tpl = document.getElementById(templateId);
    if (!tpl) { console.error('Template not found:', templateId); return; }
    appEl.innerHTML = '';
    appEl.appendChild(tpl.content.cloneNode(true));
  }

  // ---- HOME PAGE ----
  function showHomePage({ prefillId } = {}) {
    render('tpl-home');
    DataCounter.reset();

    let selectedMode = 'local';

    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedMode = btn.dataset.mode;
      });
    });

    // Create room
    document.getElementById('create-room-btn').addEventListener('click', async () => {
      const nickname = document.getElementById('host-nickname').value.trim();
      const password = document.getElementById('room-password').value;
      if (!nickname) { Utils.toast('Enter a nickname'); return; }

      const btn = document.getElementById('create-room-btn');
      btn.disabled = true;
      btn.textContent = 'Creating...';

      try {
        const res = await fetch('/api/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nickname, mode: selectedMode, password }),
        });
        if (!res.ok) throw new Error('Failed to create room');
        const data = await res.json();
        const { roomId, hostToken } = data;
        history.pushState({}, '', '/join/' + roomId);
        await showWatchPage({ roomId, nickname, hostToken, password: null });
      } catch (err) {
        Utils.toast(err.message);
        btn.disabled = false;
        btn.textContent = 'Create Room';
      }
    });

    // Room code lookup on input
    const codeInput = document.getElementById('room-code-input');
    let lookupTimer = null;
    codeInput.addEventListener('input', () => {
      clearTimeout(lookupTimer);
      const code = codeInput.value.trim().toUpperCase();
      if (code.length === 6) {
        lookupTimer = setTimeout(() => lookupRoom(code), 400);
      }
    });

    async function lookupRoom(code) {
      try {
        const res = await fetch('/api/rooms/' + code);
        if (!res.ok) { Utils.toast('Room not found'); return; }
        const data = await res.json();
        document.getElementById('join-password-field').style.display = data.hasPassword ? '' : 'none';
      } catch (_) {}
    }

    // Join room
    document.getElementById('join-room-btn').addEventListener('click', async () => {
      const nickname = document.getElementById('guest-nickname').value.trim();
      const code = document.getElementById('room-code-input').value.trim().toUpperCase();
      const password = document.getElementById('join-password').value;
      if (!nickname) { Utils.toast('Enter a nickname'); return; }
      if (!code || code.length !== 6) { Utils.toast('Enter a 6-character room code'); return; }

      const btn = document.getElementById('join-room-btn');
      btn.disabled = true;
      btn.textContent = 'Joining...';

      try {
        const res = await fetch('/api/rooms/' + code);
        if (!res.ok) throw new Error('Room not found. Check the code and try again.');
        const roomData = await res.json();
        history.pushState({}, '', '/join/' + roomData.roomId);
        await showWatchPage({ roomId: roomData.roomId, nickname, hostToken: null, password });
      } catch (err) {
        Utils.toast(err.message);
        btn.disabled = false;
        btn.textContent = 'Join Room';
      }
    });

    // Prefill from join link
    if (prefillId) {
      fetch('/api/rooms/' + prefillId)
        .then(r => r.json())
        .then(data => {
          if (data.code) {
            document.getElementById('room-code-input').value = data.code;
            if (data.hasPassword) document.getElementById('join-password-field').style.display = '';
          }
        })
        .catch(() => {});
    }
  }

  // ---- WATCH PAGE ----
  async function showWatchPage({ roomId, nickname, hostToken, password }) {
    render('tpl-watch');

    let roomData;
    try {
      roomData = await Room.join({ roomId, nickname, password, hostToken });
    } catch (err) {
      Utils.toast(err.message || 'Could not join room');
      history.pushState({}, '', '/');
      showHomePage({});
      return;
    }

    const { mode, settings, code, chat, isHost, media } = roomData;

    // Header
    document.getElementById('room-name-display').textContent = nickname + "'s room";
    const codeBadge = document.getElementById('room-code-badge');
    codeBadge.textContent = code;
    codeBadge.title = 'Click to copy code';
    codeBadge.addEventListener('click', () => Utils.copyText(code));

    const modeLabels = { local: 'Local Sync', upload: 'Upload', screenshare: 'Screen Share' };
    document.getElementById('room-mode-badge').textContent = modeLabels[mode] || mode;

    // Render prior chat
    const chatBox = document.getElementById('chat-messages');
    (chat || []).forEach(msg => {
      const div = document.createElement('div');
      div.className = 'chat-msg';
      div.innerHTML = '<span class="chat-nick">' + escHtml(msg.nickname) + '</span><span class="chat-text">' + escHtml(msg.text) + '</span>';
      chatBox.appendChild(div);
    });

    Room.applySettings(settings);
    Room.toggleHostUI(isHost);
    if (isHost) Room.syncSettingsUI(settings);

    // Show correct mode panel only
    ['local', 'upload', 'screenshare'].forEach(m => {
      document.getElementById(m + '-panel').style.display = m === mode ? '' : 'none';
    });

    // Init mode
    const socket = Room.getSocket();
    if (mode === 'local')         initLocalMode(isHost, settings);
    else if (mode === 'upload')   initUploadMode(isHost, settings, roomId, hostToken, media, socket);
    else if (mode === 'screenshare') initScreenShareMode(isHost, socket, roomId);

    // Chat send
    const chatInput = document.getElementById('chat-input');
    function sendChat() {
      const text = chatInput.value.trim();
      if (!text) return;
      Room.emitChat(text);
      chatInput.value = '';
    }
    document.getElementById('chat-send-btn').addEventListener('click', sendChat);
    chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

    // Copy invite link
    document.getElementById('copy-link-btn').addEventListener('click', () => {
      Utils.copyText(location.origin + '/join/' + roomId);
    });

    // Leave room
    document.getElementById('leave-room-btn').addEventListener('click', () => {
      Room.leave();
      history.pushState({}, '', '/');
      showHomePage({});
    });

    // Host settings toggles
    if (isHost) {
      const settingMap = {
        'setting-host-only': 'hostOnlyControl',
        'setting-chat':      'chatEnabled',
        'setting-voice':     'voiceEnabled',
        'setting-datasaver': 'dataSaver',
      };
      Object.entries(settingMap).forEach(([elId, key]) => {
        const el = document.getElementById(elId);
        if (el) el.addEventListener('change', () => Room.emitSettingsUpdate({ [key]: el.checked }));
      });
    }

    document.getElementById('settings-toggle-btn').addEventListener('click', () => {
      if (!isHost) { Utils.toast('Only the host can change settings'); return; }
      const panel = document.getElementById('host-panel');
      if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none';
    });

    // Quality selector
    const qualSel = document.getElementById('quality-select');
    if (qualSel) {
      qualSel.value = settings.defaultQuality || 'low';
      qualSel.addEventListener('change', () => Room.emitQualityChange(qualSel.value));
    }
  }

  // ---- LOCAL SYNC MODE ----
  function initLocalMode(isHost, settings) {
    const fileInput = document.getElementById('local-file-input');
    const loadBtn   = document.getElementById('local-load-btn');
    const video     = document.getElementById('local-video');
    const prompt    = document.getElementById('local-prompt');

    // Hide quality selector — not applicable for local files
    const qs = document.getElementById('quality-select');
    if (qs) qs.style.display = 'none';

    loadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      video.src = URL.createObjectURL(file);
      video.style.display = '';
      prompt.style.display = 'none';
      Player.init(video, 'local', isHost, settings);
      Room.addSystemMessage('Video loaded locally. Both users must load the same file.');
    });
  }

  // ---- UPLOAD MODE ----
  function initUploadMode(isHost, settings, roomId, hostToken, existingMedia, socket) {
    const video = document.getElementById('upload-video');

    // Late-joining guest: media already exists
    if (existingMedia && existingMedia.url) {
      showUploadVideo(video, existingMedia.url, isHost, settings);
      return;
    }

    if (isHost) {
      document.getElementById('upload-host-prompt').style.display = '';
      const fileInput    = document.getElementById('upload-file-input');
      const uploadBtn    = document.getElementById('upload-file-btn');
      const progressWrap = document.getElementById('upload-progress');
      const fill         = document.getElementById('progress-fill');
      const progressText = document.getElementById('progress-text');

      uploadBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        uploadBtn.style.display = 'none';
        progressWrap.style.display = '';

        const xhr  = new XMLHttpRequest();
        const form = new FormData();
        form.append('video', file);
        form.append('roomId', roomId);
        form.append('hostToken', hostToken);

        let lastLoaded = 0;
        xhr.upload.addEventListener('progress', e => {
          if (!e.lengthComputable) return;
          const pct = Math.round(e.loaded / e.total * 100);
          fill.style.width = pct + '%';
          progressText.textContent = 'Uploading... ' + pct + '%';
          DataCounter.add(e.loaded - lastLoaded);
          lastLoaded = e.loaded;
        });

        xhr.addEventListener('load', () => {
          try {
            const data = JSON.parse(xhr.responseText);
            if (data.url) {
              progressWrap.style.display = 'none';
              showUploadVideo(video, data.url, true, settings);
              Room.addSystemMessage('Video ready: ' + data.filename);
            } else {
              Utils.toast('Upload failed: ' + (data.error || 'Unknown error'));
              uploadBtn.style.display = '';
              progressWrap.style.display = 'none';
            }
          } catch (_) { Utils.toast('Upload failed'); }
        });

        xhr.addEventListener('error', () => Utils.toast('Network error during upload'));
        xhr.open('POST', '/api/upload');
        xhr.send(form);
      });
    } else {
      document.getElementById('upload-guest-prompt').style.display = '';
      // Real-time notify when host finishes upload
      if (socket) {
        socket.on('media_ready', ({ url, filename }) => {
          showUploadVideo(video, url, false, settings);
          document.getElementById('upload-guest-prompt').style.display = 'none';
          Room.addSystemMessage('Video ready: ' + filename);
        });
      }
    }
  }

  function showUploadVideo(video, url, isHost, settings) {
    video.src = url;
    video.style.display = '';
    const hp = document.getElementById('upload-host-prompt');
    const gp = document.getElementById('upload-guest-prompt');
    if (hp) hp.style.display = 'none';
    if (gp) gp.style.display = 'none';
    Player.init(video, 'upload', isHost, settings);
  }

  // ---- SCREEN SHARE MODE ----
  function initScreenShareMode(isHost, socket, roomId) {
    if (isHost) {
      document.getElementById('ss-host-prompt').style.display = '';
      document.getElementById('ss-start-btn').addEventListener('click', () => {
        ScreenShare.startShare(socket, roomId);
      });
      if (socket) {
        socket.on('ss_answer', ({ answer }) => ScreenShare.handleAnswer(answer));
        socket.on('ss_ice',    ({ candidate }) => ScreenShare.handleIce(candidate));
      }
    } else {
      document.getElementById('ss-guest-prompt').style.display = '';
      if (socket) {
        ScreenShare.initReceiver(socket, roomId);
        socket.on('ss_stopped', () => {
          const v = document.getElementById('ss-video');
          if (v) { v.srcObject = null; v.style.display = 'none'; }
          document.getElementById('ss-guest-prompt').style.display = '';
          Room.addSystemMessage('Host ended screen share');
        });
      }
    }
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  window.addEventListener('popstate', route);
  route();

}); // end DOMContentLoaded
