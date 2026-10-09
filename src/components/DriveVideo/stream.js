import { isIos } from '../../utils/browser.js';

// Both playback paths receive the same stream; the media element owns its clock.
export function openStream(video, url, { onError, onWaiting, onAudio, startPosition = 0 }) {
  let hls;
  let native = false;
  let destroyed = false;
  let position = startPosition;
  const seek = (nextPosition) => {
    if (destroyed) return;
    position = nextPosition;
    try {
      if (native) video.currentTime = position;
      else if (hls?.levels.length) hls.startLoad(position);
    } catch (error) {
      onError(error);
    }
  };
  const openNative = () => {
    native = true;
    video.src = url;
    video.load();
    seek(position);
  };
  try {
    const nativeSupported = video.canPlayType('application/vnd.apple.mpegurl');
    // Keep iOS audio native. Elsewhere MSE can start past a missing first fragment.
    if (nativeSupported && isIos()) {
      openNative();
    } else {
      import('hls.js').then(({ default: Hls }) => {
        if (destroyed) return;
        if (!Hls.isSupported()) {
          if (nativeSupported) { openNative(); return; }
          throw new Error('HLS playback is not supported by this browser.');
        }
        hls = new Hls({ autoStartLoad: false, maxBufferLength: 40 });
        hls.on(Hls.Events.MANIFEST_PARSED, () => { if (!destroyed) hls.startLoad(position); });
        hls.on(Hls.Events.ERROR, (_event, error) => {
          if (destroyed) return;
          if (error.fatal) onError(error);
          else if (error.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) onWaiting();
        });
        hls.on(Hls.Events.BUFFER_CODECS, (_event, codecs) => { if (!destroyed && codecs.audio) onAudio(); });
        hls.loadSource(url);
        hls.attachMedia(video);
      }).catch((error) => { if (!destroyed) onError(error); });
    }
  } catch (error) {
    onError(error);
  }
  return {
    seek,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      hls?.destroy();
      video.removeAttribute('src');
      video.load();
    },
  };
}
