import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { createStore } from 'redux';

import DriveVideo from '.';
import { currentOffset } from '../../timeline';
import { bufferVideo, play, reducer as playbackReducer, seek } from '../../timeline/playback';
import { ACTION_BUFFER_VIDEO } from '../../actions/types';

const player = vi.hoisted(() => ({ store: null, props: null, media: null, handle: null, renders: 0 }));
vi.mock('../../store', () => ({ default: { getState: () => player.store.getState() } }));
vi.mock('../../api/backend', () => ({ api: { video: {
  getQcameraStreamUrl: (route) => `https://video.example/${route}.m3u8`,
} } }));
vi.mock('../../utils/browser.js', () => ({ isIos: () => false, isFirefox: () => false }));
vi.mock('react-player/file', () => ({ default: React.forwardRef((props, ref) => {
  player.props = props;
  player.renders += 1;
  React.useImperativeHandle(ref, () => player.handle, []);
  React.useLayoutEffect(() => {
    if (props.playing && player.media.paused) player.media.play();
    if (!props.playing && !player.media.paused) player.media.pause();
  }, [props.playing]);
  return <video data-testid="drive-player" {...props.config.file?.attributes} />;
}) }));

function renderVideo() {
  player.renders = 0;
  const route = { fullname: 'aaaaaaaaaaaaaaaa|2026-08-06--12-00-00', videoStartOffset: 0 };
  const initial = {
    dongleId: 'aaaaaaaaaaaaaaaa', currentRoute: route, routes: [route],
    desiredPlaySpeed: 0, isBufferingVideo: false, offset: 4000, startTime: Date.now(),
    loop: { startTime: 0, duration: 8000 }, zoom: { start: 0, end: 8000 },
  };
  player.media = {
    currentTime: 4, readyState: 4, seeking: false, paused: true, playbackRate: 1,
    videoWidth: 0, videoHeight: 0,
    buffered: { length: 1, start: () => 0, end: () => 8 },
    play: vi.fn(() => {
      player.media.paused = false;
      player.props.onPlay();
      return Promise.resolve();
    }),
    pause: vi.fn(() => { player.media.paused = true; }),
  };
  const hls = { on: vi.fn() };
  player.handle = {
    getDuration: () => 8,
    getCurrentTime: () => player.media.currentTime,
    getInternalPlayer: (kind) => kind === 'hls' ? hls : player.media,
    seekTo: vi.fn((seconds) => {
      player.media.currentTime = seconds;
      player.media.seeking = true;
      player.media.readyState = 1;
    }),
  };
  player.store = createStore((state = initial, action) => action.type === 'test/select-route'
    ? { ...state, currentRoute: action.route }
    : playbackReducer(state, action));
  const dispatch = vi.spyOn(player.store, 'dispatch');
  const view = render(<Provider store={player.store}><DriveVideo isMuted /></Provider>);
  return { store: player.store, dispatch, ...view };
}

function seekToOneSecond() {
  act(() => vi.advanceTimersByTime(201));
  act(() => player.store.dispatch(seek(1000)));
  expect(player.media.currentTime).toBe(1);
  expect(player.store.getState().isBufferingVideo).toBe(true);
}

function completeSeek() {
  player.media.seeking = false;
  player.media.readyState = 4;
  act(() => player.props.onSeek?.(player.media.currentTime));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('a completed buffered seek clears the loading state while preserving paused intent', () => {
  const { store } = renderVideo();
  seekToOneSecond();
  expect(screen.getByRole('progressbar')).toBeInTheDocument();
  completeSeek();
  expect(store.getState()).toMatchObject({ isBufferingVideo: false, desiredPlaySpeed: 0, offset: 1000 });
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(player.media.paused).toBe(true);
  expect(player.media.play).not.toHaveBeenCalled();
});

test('playing immediately after a paused seek advances the clock without a later rewind or pause', () => {
  let synchronize;
  const scheduleInterval = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
    if (delay !== 500) return scheduleInterval(callback, delay, ...args);
    synchronize = callback;
    return 0;
  });
  const { store } = renderVideo();
  seekToOneSecond();
  completeSeek();
  player.handle.seekTo.mockClear();
  player.media.pause.mockClear();
  act(() => store.dispatch(play()));
  expect(player.media.paused).toBe(false);

  // Model a synchronization tick delayed until 600 ms of native playback.
  act(() => vi.advanceTimersByTime(600));
  player.media.currentTime = 1.65;
  act(() => synchronize());
  expect({
    offset: currentOffset(), seeks: player.handle.seekTo.mock.calls,
    pauses: player.media.pause.mock.calls.length, nativeTime: player.media.currentTime,
    buffering: store.getState().isBufferingVideo,
  }).toEqual({ offset: 1600, seeks: [], pauses: 0, nativeTime: 1.65, buffering: false });
});

test.each(['onPlay', 'onBufferEnd'])('%s restarts a ready clock only once', (event) => {
  const { store, dispatch } = renderVideo();
  act(() => store.dispatch(bufferVideo(true)));
  dispatch.mockClear();
  act(() => player.props[event]());
  act(() => player.props[event]());
  expect(store.getState().isBufferingVideo).toBe(false);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: ACTION_BUFFER_VIDEO, buffering: false });
});

test.each([
  ['unready', { readyState: 1 }],
  ['still seeking', { seeking: true }],
  ['unbuffered', { buffered: { length: 0 } }],
  ['outside the buffered range', { buffered: { length: 1, start: () => 5, end: () => 8 } }],
  ['at the buffered endpoint', { currentTime: 8 }],
])('%s video keeps the clock buffering after a readiness event', (_description, media) => {
  const { store, dispatch } = renderVideo();
  act(() => store.dispatch(bufferVideo(true)));
  Object.assign(player.media, media);
  dispatch.mockClear();
  act(() => player.props.onBufferEnd());
  expect(store.getState().isBufferingVideo).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();
});

test('a readiness event without an internal player does not clear buffering', () => {
  const { store, dispatch } = renderVideo();
  act(() => store.dispatch(bufferVideo(true)));
  player.handle.getInternalPlayer = () => null;
  dispatch.mockClear();
  act(() => player.props.onBufferEnd());
  expect(store.getState().isBufferingVideo).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();
});

test('resuming ready video still clears an earlier video error', () => {
  renderVideo();
  act(() => player.props.onError({ name: 'NetworkError' }));
  expect(screen.getByText('Unable to load video')).toBeInTheDocument();
  act(() => player.props.onBufferEnd());
  expect(screen.queryByText('Unable to load video')).not.toBeInTheDocument();
});

test('the loading frame uses the qcamera ratio and contains video without a fixed minimum height', () => {
  renderVideo();
  const video = screen.getByTestId('drive-player');
  expect(video.closest('.DriveVideo')).toHaveStyle({ aspectRatio: String(526 / 330) });
  expect(video.closest('.DriveVideo').className).not.toContain('min-h');
  expect(video).toHaveStyle({ width: '100%', height: '100%', objectFit: 'contain' });
});

test.each([[526, 330], [320, 180]])('native metadata sizes the frame to %i×%i without replacing the player', (width, height) => {
  const { store } = renderVideo();
  const video = screen.getByTestId('drive-player');
  const state = store.getState();
  const handle = player.handle;
  Object.assign(player.media, { videoWidth: width, videoHeight: height });
  fireEvent.loadedMetadata(video);
  expect(video.closest('.DriveVideo')).toHaveStyle({ aspectRatio: String(width / height) });
  expect(screen.getByTestId('drive-player')).toBe(video);
  expect(player.handle).toBe(handle);
  expect(store.getState()).toBe(state);
  expect(player.media.play).not.toHaveBeenCalled();
  expect(player.media.pause).not.toHaveBeenCalled();
});

test('native resize updates the same frame and repeated dimensions do not rerender it', () => {
  renderVideo();
  const video = screen.getByTestId('drive-player');
  Object.assign(player.media, { videoWidth: 526, videoHeight: 330 });
  fireEvent.loadedMetadata(video);
  Object.assign(player.media, { videoWidth: 320, videoHeight: 180 });
  fireEvent.resize(video);
  expect(video.closest('.DriveVideo')).toHaveStyle({ aspectRatio: String(320 / 180) });
  const renders = player.renders;
  fireEvent.resize(video);
  fireEvent.loadedMetadata(video);
  expect(player.renders).toBe(renders);
  expect(screen.getByTestId('drive-player')).toBe(video);
});

test.each([[0, 180], [320, 0], [-320, 180], [Infinity, 180], [320, Infinity], [NaN, 180]])(
  'invalid native dimensions %s×%s retain the last valid ratio', (width, height) => {
    renderVideo();
    const video = screen.getByTestId('drive-player');
    Object.assign(player.media, { videoWidth: 320, videoHeight: 180 });
    fireEvent.loadedMetadata(video);
    const renders = player.renders;
    Object.assign(player.media, { videoWidth: width, videoHeight: height });
    fireEvent.resize(video);
    expect(video.closest('.DriveVideo')).toHaveStyle({ aspectRatio: String(320 / 180) });
    expect(player.renders).toBe(renders);
  },
);

test('player readiness recovers dimensions if metadata arrived before the handler', () => {
  renderVideo();
  Object.assign(player.media, { videoWidth: 320, videoHeight: 180 });
  act(() => player.props.onReady(player.handle));
  expect(screen.getByTestId('drive-player').closest('.DriveVideo'))
    .toHaveStyle({ aspectRatio: String(320 / 180) });
});

test('unrelated renders preserve dimensions while a changed or cleared route resets the loading ratio', () => {
  const { store, rerender } = renderVideo();
  const video = screen.getByTestId('drive-player');
  Object.assign(player.media, { videoWidth: 320, videoHeight: 180 });
  fireEvent.loadedMetadata(video);
  rerender(<Provider store={store}><DriveVideo isMuted={false} /></Provider>);
  expect(video.closest('.DriveVideo')).toHaveStyle({ aspectRatio: String(320 / 180) });
  act(() => store.dispatch({ type: 'test/select-route', route: { fullname: 'bbbbbbbbbbbbbbbb|2026-08-06--12-00-00' } }));
  expect(video.closest('.DriveVideo')).toHaveStyle({ aspectRatio: String(526 / 330) });
  expect(screen.getByTestId('drive-player')).toBe(video);
  fireEvent.loadedMetadata(video);
  expect(video.closest('.DriveVideo')).toHaveStyle({ aspectRatio: String(320 / 180) });
  act(() => store.dispatch({ type: 'test/select-route', route: null }));
  fireEvent.resize(video);
  expect(video.closest('.DriveVideo')).toHaveStyle({ aspectRatio: String(526 / 330) });
});
