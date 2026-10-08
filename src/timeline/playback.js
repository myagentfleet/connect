import * as Types from '../actions/types';

export const VideoStatus = {
  LOADING: 'loading',
  READY: 'ready',
  FAILED: 'failed',
};

// User seeks are commands; progress only reports the media clock. Keeping them
// separate prevents feedback seeks and records analytics only for user actions.
export function reducer(state, action) {
  switch (action.type) {
    case Types.ACTION_SEEK:
      if (!Number.isFinite(action.offset)) return state;
      return {
        ...state,
        offset: Math.max(state.loop?.startTime ?? 0, Math.min(action.offset,
          state.loop ? state.loop.startTime + state.loop.duration : state.currentRoute?.duration ?? Infinity)),
        seekRequest: action,
      };
    case Types.ACTION_VIDEO_PROGRESS:
      return Number.isFinite(action.offset) ? { ...state, offset: action.offset } : state;
    case Types.ACTION_PLAYBACK_SPEED:
      return Number.isFinite(action.speed) && action.speed > 0 && action.speed <= 8
        ? { ...state, desiredPlaySpeed: action.speed } : state;
    case Types.ACTION_PLAY:
      return { ...state, isPlaying: true };
    case Types.ACTION_PAUSE:
      return { ...state, isPlaying: false };
    case Types.ACTION_LOOP:
      return {
        ...state,
        loop: Number.isFinite(action.start) && Number.isFinite(action.end) && action.start >= 0 && action.end > action.start
          ? { startTime: action.start, duration: action.end - action.start }
          : null,
      };
    case Types.ACTION_RESET:
      return {
        ...state,
        offset: state.loop?.startTime ?? 0,
        seekRequest: null,
        desiredPlaySpeed: 1,
        isPlaying: true,
        hasAudio: false,
        videoStatus: VideoStatus.LOADING,
      };
    case Types.ACTION_HAS_AUDIO:
      return { ...state, hasAudio: action.hasAudio };
    case Types.ACTION_VIDEO_STATUS:
      return { ...state, videoStatus: action.status };
    default:
      return state;
  }
}

export function videoProgress(offset) {
  return { type: Types.ACTION_VIDEO_PROGRESS, offset };
}

// seek to a specific offset
export function seek(offset) {
  return {
    type: Types.ACTION_SEEK,
    offset,
  };
}

// change playback speed without changing play/pause state
export function setPlaybackSpeed(speed) {
  return {
    type: Types.ACTION_PLAYBACK_SPEED,
    speed,
  };
}

export function play() {
  return { type: Types.ACTION_PLAY };
}

export function pause() {
  return { type: Types.ACTION_PAUSE };
}

export function selectLoop(start, end) {
  return {
    type: Types.ACTION_LOOP,
    start,
    end,
  };
}

export function resetPlayback() {
  return {
    type: Types.ACTION_RESET,
  };
}

export function setHasAudio(hasAudio) {
  return {
    type: Types.ACTION_HAS_AUDIO,
    hasAudio,
  };
}

export function setVideoStatus(status) {
  return {
    type: Types.ACTION_VIDEO_STATUS,
    status,
  };
}
