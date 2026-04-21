// player.js - video player logic for local and upload modes

const Player = (() => {
  let video = null;
  let isSyncing = false; // prevents echo loops
  let canControl = false;
  const SYNC_THRESHOLD = 1.5; // seconds drift before force-sync

  function init(videoEl, mode, isHost, settings) {
    video = videoEl;
    canControl = !settings.hostOnlyControl || isHost;

    // Progress bar updates
    video.addEventListener('timeupdate', () => {
      updateProgressBar();
      updateTimeDisplay();
    });

    video.addEventListener('durationchange', updateTimeDisplay);

    // User-initiated play/pause
    video.addEventListener('play', () => {
      if (isSyncing) return;
      if (!canControl) { video.pause(); return; }
      Room.emitPlay(video.currentTime);
      updatePlayBtn(true);
    });

    video.addEventListener('pause', () => {
      if (isSyncing) return;
      if (!canControl) return;
      Room.emitPause(video.currentTime);
      updatePlayBtn(false);
    });

    // Seek via progress track
    const track = document.getElementById('progress-track');
    if (track) {
      track.addEventListener('click', (e) => {
        if (!canControl || !video.duration) return;
        const rect = track.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        const ts = ratio * video.duration;
        video.currentTime = ts;
        Room.emitSeek(ts);
      });
    }

    // Play/pause button
    const ppBtn = document.getElementById('play-pause-btn');
    if (ppBtn) {
      ppBtn.addEventListener('click', () => {
        if (!canControl) { Utils.toast('Only the host can control playback'); return; }
        if (video.paused) video.play();
        else video.pause();
      });
    }

    // Speed
    const speedSel = document.getElementById('speed-select');
    if (speedSel) {
      speedSel.addEventListener('change', () => {
        if (!canControl) return;
        const rate = parseFloat(speedSel.value);
        video.playbackRate = rate;
        Room.emitRate(rate);
      });
    }

    // Fullscreen
    const fsBtn = document.getElementById('fullscreen-btn');
    if (fsBtn) {
      fsBtn.addEventListener('click', () => {
        const container = document.getElementById('video-container');
        if (document.fullscreenElement) document.exitFullscreen();
        else container.requestFullscreen?.();
      });
    }

    // Quality selector (upload mode only)
    const qualSel = document.getElementById('quality-select');
    if (qualSel && mode === 'upload') {
      qualSel.style.display = '';
      qualSel.value = settings.defaultQuality || 'low';
    } else if (qualSel) {
      qualSel.style.display = 'none';
    }

    // Request sync on ready
    video.addEventListener('canplay', () => {
      Room.requestSync();
    }, { once: true });

    DataCounter.trackVideoElement(video);
  }

  function updateCanControl(settings, isHost) {
    canControl = !settings.hostOnlyControl || isHost;
  }

  // Remote event handlers
  function handleRemotePlay(timestamp) {
    if (!video) return;
    isSyncing = true;
    syncTimestamp(timestamp);
    video.play().catch(() => {});
    updatePlayBtn(true);
    setTimeout(() => { isSyncing = false; }, 300);
  }

  function handleRemotePause(timestamp) {
    if (!video) return;
    isSyncing = true;
    syncTimestamp(timestamp);
    video.pause();
    updatePlayBtn(false);
    setTimeout(() => { isSyncing = false; }, 300);
  }

  function handleRemoteSeek(timestamp) {
    if (!video) return;
    isSyncing = true;
    video.currentTime = timestamp;
    setTimeout(() => { isSyncing = false; }, 300);
  }

  function handleRemoteRate(rate) {
    if (!video) return;
    video.playbackRate = rate;
    const sel = document.getElementById('speed-select');
    if (sel) sel.value = String(rate);
  }

  function applySync(playback) {
    if (!video) return;
    const drift = Math.abs(video.currentTime - playback.timestamp);
    if (drift > SYNC_THRESHOLD) {
      isSyncing = true;
      video.currentTime = playback.timestamp;
      setTimeout(() => { isSyncing = false; }, 300);
    }
    if (playback.state === 'playing' && video.paused) {
      isSyncing = true;
      video.play().catch(() => {});
      updatePlayBtn(true);
      setTimeout(() => { isSyncing = false; }, 300);
    } else if (playback.state === 'paused' && !video.paused) {
      isSyncing = true;
      video.pause();
      updatePlayBtn(false);
      setTimeout(() => { isSyncing = false; }, 300);
    }
  }

  function syncTimestamp(timestamp) {
    if (!video) return;
    const drift = Math.abs(video.currentTime - timestamp);
    if (drift > SYNC_THRESHOLD) video.currentTime = timestamp;
  }

  function updateProgressBar() {
    const played = document.getElementById('progress-played');
    if (!played || !video || !video.duration) return;
    const pct = (video.currentTime / video.duration) * 100;
    played.style.width = `${pct}%`;
  }

  function updateTimeDisplay() {
    const el = document.getElementById('time-display');
    if (!el || !video) return;
    el.textContent = `${Utils.formatTime(video.currentTime)} / ${Utils.formatTime(video.duration)}`;
  }

  function updatePlayBtn(playing) {
    const btn = document.getElementById('play-pause-btn');
    if (btn) btn.textContent = playing ? 'Pause' : 'Play';
  }

  function setVideo(el) { video = el; }
  function getVideo() { return video; }

  return {
    init, updateCanControl,
    handleRemotePlay, handleRemotePause, handleRemoteSeek, handleRemoteRate,
    applySync, setVideo, getVideo,
  };
})();
