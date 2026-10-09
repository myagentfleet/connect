import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { createStore } from 'redux';
import Hls from 'hls.js';

import DriveVideo from '.';
import { createInitialState } from '../../initialState';
import { pause, play, reducer, seek, selectLoop, setPlaybackSpeed } from '../../timeline/playback';

const mocks = vi.hoisted(() => ({ streams: [] }));
vi.mock('../../api/backend', () => ({
  api: { video: { getQcameraStreamUrl: (name) => `https://example.com/${name}.m3u8` } },
}));
vi.mock('hls.js', () => ({
  default: class {
    static isSupported = vi.fn(() => true);
    static Events = { ERROR: 'error', BUFFER_CODECS: 'codecs', MANIFEST_PARSED: 'manifest' };
    levels = [];
    handlers = {};
    loadSource = vi.fn();
    startLoad = vi.fn();
    attachMedia = vi.fn();
    destroy = vi.fn();
    constructor(config) { this.config = config; mocks.streams.push(this); }
    on(event, handler) { this.handlers[event] = handler; }
    emit(event, data) {
      if (event === this.constructor.Events.MANIFEST_PARSED) this.levels = [{}];
      this.handlers[event]?.(event, data);
    }
  },
}));

const route = { fullname: 'drive', duration: 60000, videoStartOffset: 2000 };
const media = (video, values) => Object.defineProperties(video, Object.fromEntries(
  Object.entries(values).map(([key, value]) => [key, { configurable: true, writable: true, value }]),
));

beforeEach(() => {
  mocks.streams.length = 0;
  Hls.isSupported.mockReturnValue(true);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone');
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function () {
    media(this, { paused: false, ended: false });
    fireEvent.playing(this);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function () {
    if (!this.paused) {
      media(this, { paused: true });
      fireEvent.pause(this);
    }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mountVideo(state = {}) {
  const store = createStore((value, action) => action.type === 'TEST_ROUTE'
    ? { ...value, currentRoute: action.route }
    : reducer(value, action), { ...createInitialState('/'), currentRoute: route, ...state });
  const view = render(<Provider store={store}><DriveVideo isMuted /></Provider>);
  return { ...view, store, video: view.getByLabelText('Drive video') };
}

function ready(video, duration = 58) {
  const stream = mocks.streams.at(-1);
  if (stream?.attachMedia.mock.lastCall?.[0] === video && !stream.levels.length) stream.emit(Hls.Events.MANIFEST_PARSED);
  media(video, { duration, readyState: 4, seeking: false });
  fireEvent.loadedMetadata(video);
  fireEvent.canPlay(video);
}

async function finishImport() {
  await act(async () => { await vi.dynamicImportSettled(); });
}

async function prefetchFailure(loopEnd = 180000) {
  HTMLMediaElement.prototype.canPlayType.mockReturnValue('');
  const view = mountVideo({ currentRoute: { ...route, duration: 180000, videoStartOffset: 0 },
    loop: { startTime: 0, duration: loopEnd } });
  await finishImport();
  media(view.video, { buffered: { length: 1, start: () => 0, end: () => 60 } });
  ready(view.video, 180);
  const stream = mocks.streams[0];
  act(() => stream.emit(Hls.Events.ERROR, { fatal: true, frag: { start: 60, duration: 60 }, response: { code: 404 } }));
  return { ...view, stream };
}

test('the media clock drives progress without feedback seeks or rate corrections', () => {
  const { video, store } = mountVideo();
  ready(video);
  video.currentTime = 12.345;
  fireEvent.timeUpdate(video);
  expect(store.getState().offset).toBe(14345);
  expect(store.getState().seekRequest).toBeNull();
  expect(video.currentTime).toBe(12.345);
  act(() => store.dispatch(setPlaybackSpeed(4)));
  expect(video.playbackRate).toBe(4);
  expect(video.currentTime).toBe(12.345);
});

test('advancing media clears stale native waiting without a matching playing event', () => {
  const { video, store } = mountVideo();
  ready(video);
  fireEvent.waiting(video);
  fireEvent.timeUpdate(video);
  expect(store.getState().videoStatus).toBe('loading');
  media(video, { readyState: 2 });
  video.currentTime = 1.25;
  fireEvent.timeUpdate(video);
  expect(store.getState()).toMatchObject({ offset: 3250, isPlaying: true, videoStatus: 'ready' });
  expect(video.play).toHaveBeenCalledTimes(1);
  expect(video.currentTime).toBe(1.25);
});

test('the focused video control survives buffering and can pause before playback is ready', () => {
  const { video, store, getByRole } = mountVideo();
  ready(video);
  const control = getByRole('button', { name: 'Pause video' });
  control.focus();
  media(video, { readyState: 2 });
  fireEvent.waiting(video);
  expect(store.getState().videoStatus).toBe('loading');
  expect(getByRole('button', { name: 'Pause video' })).toBe(control);
  expect(control).toHaveFocus();
  fireEvent.click(control);
  expect(store.getState().isPlaying).toBe(false);
  expect(video.paused).toBe(true);
  media(video, { readyState: 4 });
  fireEvent.canPlay(video);
  expect(store.getState()).toMatchObject({ videoStatus: 'ready', isPlaying: false });
  expect(getByRole('button', { name: 'Play video' })).toBe(control);
  expect(control).toHaveFocus();
  expect(video.paused).toBe(true);
});

test('uses the latest seek before metadata and corrects delayed first-frame metadata', () => {
  const { video, store } = mountVideo({ currentRoute: { ...route, videoStartOffset: 0 } });
  act(() => { store.dispatch(seek(9000)); store.dispatch(seek(17000)); store.dispatch(pause()); });
  expect(video.currentTime).toBe(17);
  ready(video);
  expect(video.currentTime).toBe(17);
  act(() => store.dispatch({ type: 'TEST_ROUTE', route }));
  expect(video.currentTime).toBe(15);
  fireEvent.seeked(video);
  expect(store.getState()).toMatchObject({ offset: 17000, isPlaying: false, videoStatus: 'ready' });
  expect(video.play).not.toHaveBeenCalled();
});

test('paused seeks finish with one available frame and repeated targets do not stay loading', () => {
  const { video, store } = mountVideo();
  ready(video);
  act(() => store.dispatch(pause()));
  const plays = video.play.mock.calls.length;
  act(() => store.dispatch(seek(17000)));
  fireEvent.seeking(video);
  media(video, { readyState: 2 });
  fireEvent.seeked(video);
  act(() => store.dispatch(seek(17000)));
  expect(video.currentTime).toBe(15);
  expect(store.getState()).toMatchObject({ offset: 17000, isPlaying: false, videoStatus: 'ready' });
  expect(video.play).toHaveBeenCalledTimes(plays);
});

test('holds a paused loop end and resumes from the selected start', () => {
  const { video, store } = mountVideo({ loop: { startTime: 20000, duration: 40000 } });
  ready(video);
  fireEvent.seeked(video);
  act(() => { store.dispatch(pause()); store.dispatch(seek(60000)); });
  media(video, { ended: true });
  fireEvent.seeked(video);
  expect(video.currentTime).toBe(58);
  expect(store.getState().offset).toBe(60000);
  act(() => store.dispatch(play()));
  expect(video.currentTime).toBe(18);
  fireEvent.seeked(video);
  expect(store.getState()).toMatchObject({ offset: 20000, isPlaying: true });
});

test('a selection before the first frame stops without advancing outside it and can recover', () => {
  const { video, store, getByText, queryByText, queryByRole } = mountVideo({ loop: { startTime: 0, duration: 1000 } });
  ready(video);
  fireEvent.timeUpdate(video);
  expect(getByText('No video is available in this selection.')).toBeVisible();
  expect(queryByRole('button', { name: 'Retry' })).toBeNull();
  expect(store.getState()).toMatchObject({ offset: 0, isPlaying: false, videoStatus: 'failed' });
  act(() => store.dispatch(selectLoop(20000, 30000)));
  ready(video);
  fireEvent.seeked(video);
  expect(video.currentTime).toBe(18);
  expect(queryByText('No video is available in this selection.')).toBeNull();
  expect(store.getState()).toMatchObject({ offset: 20000, isPlaying: false, videoStatus: 'ready' });
});

test('native pause and resume update requested playback without advancing a stopped clock', () => {
  const { video, store } = mountVideo();
  ready(video);
  video.currentTime = 9;
  media(video, { paused: true });
  fireEvent.pause(video);
  expect(store.getState()).toMatchObject({ offset: 11000, isPlaying: false });
  fireEvent.timeUpdate(video);
  expect(store.getState().offset).toBe(11000);
  media(video, { paused: false });
  fireEvent.playing(video);
  expect(store.getState().isPlaying).toBe(true);
});

test('blocked autoplay leaves playback paused with an available frame instead of an error', async () => {
  HTMLMediaElement.prototype.play.mockRejectedValueOnce(new DOMException('Blocked', 'NotAllowedError'));
  const { video, store, queryByRole } = mountVideo();
  await act(async () => ready(video));
  expect(store.getState()).toMatchObject({ isPlaying: false, videoStatus: 'ready' });
  expect(queryByRole('button', { name: 'Retry' })).toBeNull();
});

test.each(['initial play', 'loop restart'])('ignores a rejected old-route %s promise', async (phase) => {
  let rejectPlay;
  const pending = () => new Promise((_, reject) => { rejectPlay = reject; });
  const { video, store, getByLabelText } = mountVideo({ loop: { startTime: 20000, duration: 40000 } });
  if (phase === 'initial play') video.play.mockImplementationOnce(pending);
  await act(async () => ready(video));
  if (phase === 'loop restart') {
    video.play.mockImplementationOnce(pending);
    media(video, { paused: true, ended: true, currentTime: 58 });
    fireEvent.ended(video);
  }
  expect(rejectPlay).toBeTypeOf('function');
  act(() => store.dispatch({ type: 'TEST_ROUTE', route: { ...route, fullname: 'next' } }));
  const nextVideo = getByLabelText('Drive video');
  expect(nextVideo).not.toBe(video);
  await act(async () => { ready(nextVideo); fireEvent.seeked(nextVideo); });
  const before = store.getState();
  await act(async () => rejectPlay(new DOMException('Old request', 'NotAllowedError')));
  expect(store.getState()).toEqual(before);
});

test('detects an audio track arriving after readiness without losing it on later empty events', () => {
  const tracks = new EventTarget();
  tracks.length = 0;
  vi.spyOn(HTMLMediaElement.prototype, 'audioTracks', 'get').mockReturnValue(tracks);
  const { video, store } = mountVideo();
  ready(video);
  expect(store.getState().hasAudio).toBe(false);
  tracks.length = 1;
  act(() => tracks.dispatchEvent(new Event('addtrack')));
  expect(store.getState().hasAudio).toBe(true);
  tracks.length = 0;
  fireEvent.canPlay(video);
  expect(store.getState().hasAudio).toBe(true);
});

test.each(['retry', 'seek'])('recovers from a fatal HLS error through %s and ignores old transport callbacks', async (recovery) => {
  HTMLMediaElement.prototype.canPlayType.mockReturnValue('');
  const { video, store, getByRole, getByText, queryByRole } = mountVideo();
  await finishImport();
  ready(video);
  const stream = mocks.streams[0];
  act(() => stream.emit(Hls.Events.ERROR, { fatal: false, response: { code: 404 } }));
  expect(store.getState().videoStatus).toBe('ready');
  act(() => stream.emit(Hls.Events.ERROR, { fatal: true, response: { code: 404 } }));
  expect(getByText('This video segment has not uploaded yet or has been deleted.')).toBeVisible();
  fireEvent.waiting(video);
  expect(store.getState().videoStatus).toBe('failed');
  if (recovery === 'retry') fireEvent.click(getByRole('button', { name: 'Retry' }));
  else act(() => store.dispatch(seek(17000)));
  await finishImport();
  expect(mocks.streams).toHaveLength(2);
  expect(stream.destroy).toHaveBeenCalledTimes(1);
  act(() => {
    stream.emit(Hls.Events.ERROR, { fatal: true });
    stream.emit(Hls.Events.BUFFER_CODECS, { audio: {} });
  });
  expect(store.getState().videoStatus).toBe('loading');
  expect(store.getState().hasAudio).toBe(false);
  ready(video);
  fireEvent.seeked(video);
  expect(store.getState().videoStatus).toBe('ready');
  expect(queryByRole('button', { name: 'Retry' })).toBeNull();
  expect(store.getState().offset).toBe(recovery === 'seek' ? 17000 : 2000);
});

test('refreshing source credentials preserves the paused position and selected speed', async () => {
  HTMLMediaElement.prototype.canPlayType.mockReturnValue('');
  const { video, store } = mountVideo();
  await finishImport();
  ready(video);
  act(() => { store.dispatch(pause()); store.dispatch(setPlaybackSpeed(4)); store.dispatch(seek(17000)); });
  fireEvent.seeked(video);
  act(() => store.dispatch({ type: 'TEST_ROUTE', route: { ...route, share_sig: 'renewed' } }));
  await finishImport();
  expect(mocks.streams).toHaveLength(2);
  expect(mocks.streams[0].destroy).toHaveBeenCalledTimes(1);
  video.playbackRate = 1;
  fireEvent.rateChange(video);
  video.currentTime = 0;
  ready(video);
  fireEvent.seeked(video);
  expect(video.currentTime).toBe(15);
  expect(store.getState()).toMatchObject({ offset: 17000, desiredPlaySpeed: 4, isPlaying: false, videoStatus: 'ready' });
});

test('an unsupported playback path produces a recoverable error instead of endless loading', async () => {
  HTMLMediaElement.prototype.canPlayType.mockReturnValue('');
  Hls.isSupported.mockReturnValue(false);
  const { store, getByRole, queryByLabelText } = mountVideo();
  await finishImport();
  expect(store.getState().videoStatus).toBe('failed');
  expect(getByRole('button', { name: 'Retry' })).toBeVisible();
  expect(queryByLabelText('Loading video')).toBeNull();
});

test('HLS starts at the latest selected position and accepts new seeks before any metadata', async () => {
  HTMLMediaElement.prototype.canPlayType.mockReturnValue('');
  const { video, store } = mountVideo({ loop: { startTime: 20000, duration: 20000 } });
  act(() => store.dispatch(seek(25000)));
  await finishImport();
  const stream = mocks.streams[0];
  expect(stream.config.autoStartLoad).toBe(false);
  expect(stream.startLoad).not.toHaveBeenCalled();
  act(() => stream.emit(Hls.Events.MANIFEST_PARSED));
  expect(stream.startLoad).toHaveBeenLastCalledWith(23);
  act(() => { store.dispatch(seek(27000)); store.dispatch(seek(31000)); });
  expect(stream.startLoad).toHaveBeenLastCalledWith(29);
  expect(mocks.streams).toHaveLength(1);
  ready(video);
  fireEvent.seeked(video);
  expect(store.getState().offset).toBe(31000);
});

test('Chrome advertising native HLS uses MSE so a seek can start beyond a missing first fragment', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Chrome/154.0.0.0');
  HTMLMediaElement.prototype.canPlayType.mockReturnValue('maybe');
  const { video, store } = mountVideo({ currentRoute: { ...route, duration: 180000 } });
  await finishImport();
  const first = mocks.streams[0];
  act(() => {
    first.emit(Hls.Events.MANIFEST_PARSED);
    first.emit(Hls.Events.ERROR, { fatal: true, response: { code: 404 } });
  });
  expect(store.getState().videoStatus).toBe('failed');
  act(() => store.dispatch(seek(125000)));
  await finishImport();
  const replacement = mocks.streams[1];
  act(() => replacement.emit(Hls.Events.MANIFEST_PARSED));
  expect(replacement.startLoad).toHaveBeenLastCalledWith(123);
  ready(video, 178);
  fireEvent.seeked(video);
  expect(store.getState()).toMatchObject({ offset: 125000, videoStatus: 'ready' });
});

test.each([
  ['iPhone', 0],
  ['Macintosh', 5],
])('keeps %s playback native when MSE is also supported', async (userAgent, maxTouchPoints) => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  const originalTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: maxTouchPoints });
  try {
    const { video } = mountVideo({ loop: { startTime: 20000, duration: 20000 } });
    await finishImport();
    expect(video.src).toBe('https://example.com/drive.m3u8');
    expect(video.currentTime).toBe(18);
    expect(mocks.streams).toHaveLength(0);
  } finally {
    if (originalTouchPoints) Object.defineProperty(navigator, 'maxTouchPoints', originalTouchPoints);
    else delete navigator.maxTouchPoints;
  }
});

test('falls back to native HLS without MSE and applies the latest pending seek', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Chrome/154.0.0.0');
  Hls.isSupported.mockReturnValue(false);
  const { video, store } = mountVideo();
  act(() => { store.dispatch(seek(25000)); store.dispatch(pause()); });
  await finishImport();
  expect(video.src).toBe('https://example.com/drive.m3u8');
  expect(video.currentTime).toBe(23);
  expect(mocks.streams).toHaveLength(0);
  ready(video);
  fireEvent.seeked(video);
  expect(store.getState()).toMatchObject({ offset: 25000, isPlaying: false, videoStatus: 'ready' });
});

test('unmounting before the HLS import completes never creates an abandoned player', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Chrome/154.0.0.0');
  const { unmount, store, video } = mountVideo();
  expect(mocks.streams).toHaveLength(0);
  expect(video.getAttribute('src')).toBeNull();
  unmount();
  const before = store.getState();
  await finishImport();
  expect(mocks.streams).toHaveLength(0);
  expect(store.getState()).toEqual(before);
});

test('a failed prefetched fragment does not interrupt a healthy buffered loop', async () => {
  const { video, store, queryByRole } = await prefetchFailure(15000);
  expect(store.getState()).toMatchObject({ isPlaying: true, videoStatus: 'ready' });
  expect(video.paused).toBe(false);
  video.currentTime = 15;
  fireEvent.timeUpdate(video);
  expect(video.currentTime).toBe(0);
  fireEvent.seeking(video);
  fireEvent.waiting(video);
  fireEvent.seeked(video);
  expect(store.getState()).toMatchObject({ offset: 0, isPlaying: true, videoStatus: 'ready' });
  expect(queryByRole('button', { name: 'Retry' })).toBeNull();
  media(video, { buffered: { length: 1, start: () => 120, end: () => 180 } });
  act(() => store.dispatch(selectLoop(125000, 150000)));
  fireEvent.seeked(video);
  fireEvent.waiting(video);
  expect(store.getState()).toMatchObject({ offset: 125000, isPlaying: true, videoStatus: 'loading' });
  expect(queryByRole('button', { name: 'Retry' })).toBeNull();
});

test('a prefetched failure waits for an actual playback gap, not a buffered seek', async () => {
  const { video, store, getByRole } = await prefetchFailure();
  act(() => store.dispatch(seek(10000)));
  media(video, { seeking: true, readyState: 2 });
  fireEvent.seeking(video);
  fireEvent.waiting(video);
  expect(store.getState().videoStatus).toBe('loading');
  media(video, { seeking: false });
  fireEvent.seeked(video);
  expect(store.getState().videoStatus).toBe('ready');
  video.currentTime = 60;
  fireEvent.waiting(video);
  expect(store.getState().videoStatus).toBe('failed');
  expect(getByRole('button', { name: 'Retry' })).toBeVisible();
});

test('a seek beyond buffered video restarts a stopped HLS loader at the requested position', async () => {
  const { video, store, stream } = await prefetchFailure();
  act(() => store.dispatch(seek(125000)));
  expect(mocks.streams).toHaveLength(1);
  expect(stream.startLoad).toHaveBeenLastCalledWith(125);
  expect(video.currentTime).toBe(125);
  fireEvent.seeked(video);
  expect(store.getState()).toMatchObject({ offset: 125000, videoStatus: 'ready' });
  media(video, { readyState: 2 });
  fireEvent.waiting(video);
  expect(store.getState().videoStatus).toBe('loading');
  fireEvent.canPlay(video);
  expect(store.getState().videoStatus).toBe('ready');
});
