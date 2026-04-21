// datacounter.js - tracks approximate bandwidth usage

const DataCounter = (() => {
  let totalBytes = 0;
  const el = () => document.getElementById('data-value');

  function add(bytes) {
    totalBytes += bytes;
    const display = el();
    if (display) display.textContent = Utils.formatBytes(totalBytes);
  }

  // Estimate socket message size
  function countSocketEvent(eventName, data) {
    const payload = JSON.stringify({ event: eventName, data });
    add(payload.length); // rough byte estimate
  }

  // Track video data via PerformanceObserver if available
  function trackVideoElement(video) {
    if (!video) return;
    let lastTime = 0;
    let lastBytes = 0;

    // Use resource timing if available, otherwise estimate from bitrate
    video.addEventListener('progress', () => {
      // Estimate: track buffered ranges delta
      try {
        if (video.webkitVideoDecodedByteCount !== undefined) {
          const current = video.webkitVideoDecodedByteCount;
          add(current - lastBytes);
          lastBytes = current;
        }
      } catch (_) {}
    });
  }

  function reset() {
    totalBytes = 0;
    const display = el();
    if (display) display.textContent = '0 KB';
  }

  function getTotal() { return totalBytes; }

  return { add, countSocketEvent, trackVideoElement, reset, getTotal };
})();
