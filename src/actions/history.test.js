import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'history';
import { LOCATION_CHANGE } from 'connected-react-router';
import { createInitialState } from '../initialState';
import { createAppStore } from '../store';
import { api } from '../api/backend';
import { ACTION_ROUTES_METADATA } from './types';
import { openDialog, closeDialog, popTimelineRange, pushTimelineRange, selectDevice } from './navigation';

vi.mock('../api/backend', () => ({ api: {
  auth: { isAuthenticated: vi.fn(() => true) },
  routes: { getRoutesSegments: vi.fn(async () => []) },
} }));
vi.mock('./index', () => ({
  primeFetchSubscription: () => ({ type: 'SUBSCRIPTION_REQUEST' }),
  fetchDeviceOnline: () => ({ type: 'DEVICE_REQUEST' }),
  fetchSharedDevice: () => ({ type: 'SHARED_DEVICE_REQUEST' }),
}));
vi.mock('../analytics', () => ({ analyticsMiddleware: () => (next) => (action) => next(action) }));
vi.mock('../utils/webrtc', () => ({ webrtcConnectionManager: { disconnect: vi.fn() } }));

const DEVICE = '0000aaaa0000aaaa';
const OTHER = '1111bbbb1111bbbb';
const LOG = '2026-08-06--12-00-00';
const SECOND_LOG = '2026-08-06--13-00-00';
const DRIVE = `/${DEVICE}/${LOG}`;
const route = { fullname: `${DEVICE}|${LOG}`, log_id: LOG, duration: 60000 };
const secondRoute = { fullname: `${DEVICE}|${SECOND_LOG}`, log_id: SECOND_LOG, duration: 60000 };

function create(pathname = `/${DEVICE}`, extra = {}) {
  const history = createMemoryHistory({ initialEntries: [pathname] });
  const initial = createInitialState(history.location);
  const store = createAppStore(history, {
    ...initial,
    profile: { id: 'test' },
    devices: [{ dongle_id: DEVICE, is_owner: true }, { dongle_id: OTHER, is_owner: true }],
    device: { dongle_id: DEVICE, is_owner: true },
    routes: [route, secondRoute],
    routesMeta: { dongleId: DEVICE, ...initial.filter },
    routeCache: { [route.fullname]: route, [secondRoute.fullname]: secondRoute },
    limit: 5,
    ...extra,
  });
  history.listen((location, action) => store.dispatch({ type: LOCATION_CHANGE, payload: { location, action } }));
  store.dispatch({ type: LOCATION_CHANGE, payload: { location: history.location, action: 'POP' } });
  // Loaded routes are normally supplied by startup's asynchronous metadata response.
  store.dispatch({ type: ACTION_ROUTES_METADATA, dongleId: DEVICE, routeId: LOG, routes: [route] });
  return { history, store };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.auth.isAuthenticated.mockReturnValue(true);
  api.routes.getRoutesSegments.mockResolvedValue([]);
  localStorage.clear();
});

describe('URL to state', () => {
  it.each(['PUSH', 'REPLACE', 'POP'])('applies %s through the same transition', (action) => {
    const { store } = create();
    store.dispatch({ type: LOCATION_CHANGE, payload: { action, location: { pathname: `${DRIVE}/0/20`, search: '' } } });
    expect(store.getState()).toMatchObject({
      dongleId: DEVICE, selectedRouteId: LOG, navigation: { page: 'drive' },
      zoom: { start: 0, end: 20000 }, loop: { startTime: 0, duration: 20000 },
    });
  });

  it('preserves loaded state and playback through dialog open, Back, Forward and close', () => {
    const { history, store } = create(DRIVE);
    store.dispatch({ type: 'ACTION_SEEK', offset: 12345 });
    const before = store.getState();
    const assertReused = () => {
      const after = store.getState();
      for (const key of ['routes', 'filter', 'routeCache', 'currentRoute', 'zoom', 'loop', 'files']) {
        expect(after[key]).toBe(before[key]);
      }
      expect(after.offset).toBe(before.offset);
      expect(after.startTime).toBe(before.startTime);
    };
    store.dispatch(openDialog('settings', { deviceId: OTHER }));
    expect(store.getState().navigation).toMatchObject({ dialog: 'settings', dialogDevice: OTHER });
    assertReused();
    history.goBack();
    expect(store.getState().navigation.dialog).toBeNull();
    assertReused();
    history.goForward();
    expect(store.getState().navigation.dialog).toBe('settings');
    assertReused();
    store.dispatch(closeDialog());
    assertReused();
    expect(history.location.pathname).toBe(DRIVE);
    expect(history.location.search).toBe('');
    expect(api.routes.getRoutesSegments).not.toHaveBeenCalled();
  });

  it('clears drive selection on referrals and dashboard navigation without losing the list', () => {
    const { history, store } = create(DRIVE);
    const list = store.getState().routes;
    history.push('/referrals');
    expect(store.getState()).toMatchObject({ dongleId: DEVICE, selectedRouteId: null, zoom: null });
    store.dispatch(selectDevice(DEVICE));
    expect(store.getState().navigation.page).toBe('dashboard');
    expect(store.getState().routes).toBe(list);
    expect(api.routes.getRoutesSegments).not.toHaveBeenCalled();
  });

  it('closes nested uploads back to settings without disturbing the underlying selection', () => {
    const { history, store } = create(`${DRIVE}/0/20?x=a%26b#video`);
    store.dispatch(openDialog('settings', { deviceId: OTHER }));
    const settings = history.location;
    const zoom = store.getState().zoom;
    store.dispatch(openDialog('uploads', { deviceId: OTHER }));
    expect(store.getState().navigation).toMatchObject({
      dialog: 'uploads', dialogDevice: OTHER, dialogParent: 'settings',
    });
    store.dispatch(closeDialog());
    expect(history.location).toMatchObject({
      pathname: settings.pathname, search: settings.search, hash: settings.hash, state: settings.state,
    });
    expect(store.getState().zoom).toBe(zoom);
    history.goBack();
    expect(store.getState().navigation.dialog).toBe('uploads');
    history.goBack();
    expect(store.getState().navigation.dialog).toBe('settings');
    expect(store.getState().zoom).toBe(zoom);
  });

  it.each(['clip', 'delete-clip'])('returns %s to its inventory without resetting drive playback', (dialog) => {
    const { history, store } = create(`${DRIVE}/0/20?x=1#video`);
    store.dispatch(openDialog('clips'));
    store.dispatch({ type: 'ACTION_SEEK', offset: 12000 });
    const before = store.getState();
    store.dispatch(openDialog(dialog, { clip: '2026-08-06--12-00-00.mp4' }));
    expect(store.getState().navigation).toMatchObject({
      dialog, dialogParent: 'clips', dialogClip: '2026-08-06--12-00-00.mp4',
    });
    store.dispatch(closeDialog());
    expect(history.location).toMatchObject({ pathname: `${DRIVE}/0/20`, search: '?x=1&dialog=clips', hash: '#video' });
    history.goBack();
    expect(store.getState().navigation.dialog).toBe(dialog);
    history.goBack();
    expect(store.getState().navigation.dialog).toBe('clips');
    for (const key of ['currentRoute', 'routeCache', 'routes', 'zoom', 'loop']) {
      expect(store.getState()[key]).toBe(before[key]);
    }
    expect(store.getState().offset).toBe(12000);
    expect(api.routes.getRoutesSegments).not.toHaveBeenCalled();
  });

  it('closes a cold unpair link back to the target device settings', () => {
    const { history, store } = create(`${DRIVE}?dialog=unpair&device=${OTHER}`);
    expect(store.getState().navigation).toMatchObject({ dialog: 'unpair', dialogParent: 'settings', dialogDevice: OTHER });
    store.dispatch(closeDialog());
    expect(history.location).toMatchObject({ pathname: DRIVE, search: `?dialog=settings&device=${OTHER}` });
    expect(store.getState().dongleId).toBe(DEVICE);
    expect(store.getState().selectedRouteId).toBe(LOG);
  });

  it('closes a legacy token-pairing URL and restores its dialog on Back', () => {
    const { history, store } = create(`/${DEVICE}?x=1&pair=token.value`);
    expect(store.getState().navigation).toMatchObject({ dialog: 'pair', pairToken: 'token.value' });
    store.dispatch(closeDialog());
    expect(history.location.search).toBe('?x=1');
    expect(store.getState().navigation).toMatchObject({ dialog: null, pairToken: null });
    history.goBack();
    expect(store.getState().navigation).toMatchObject({ dialog: 'pair', pairToken: 'token.value' });
  });

  it('restores device-specific filters, lists and subscription data', () => {
    const subscription = { plan: 'test' };
    const { history, store } = create(`/${DEVICE}`, { subscription });
    const before = store.getState();
    history.push(`/${OTHER}`);
    expect(store.getState().dongleId).toBe(OTHER);
    expect(store.getState().routes).toBeNull();
    history.goBack();
    expect(store.getState().routes).toBe(before.routes);
    expect(store.getState().filter).toBe(before.filter);
    expect(store.getState().subscription).toBe(subscription);
    expect(store.getState().limit).toBe(5);
  });

  it('resets playback when drive identity changes even with equal ranges', () => {
    const { history, store } = create(`${DRIVE}/0/20`);
    store.dispatch({ type: 'ACTION_SEEK', offset: 15000 });
    history.push(`/${DEVICE}/${SECOND_LOG}/0/20`);
    expect(store.getState()).toMatchObject({ selectedRouteId: SECOND_LOG, offset: 0, isBufferingVideo: true });
    expect(store.getState().currentRoute.fullname).toBe(secondRoute.fullname);
  });

  it('zooms out repeatedly without alternating between the last two ranges', () => {
    const { history, store } = create(DRIVE);
    store.dispatch(pushTimelineRange(LOG, 10000, 50000));
    store.dispatch(pushTimelineRange(LOG, 20000, 30000));
    store.dispatch(popTimelineRange());
    expect(history.location.pathname).toBe(`${DRIVE}/10/50`);
    store.dispatch(popTimelineRange());
    expect(history.location.pathname).toBe(DRIVE);
    expect(store.getState().zoom.previous).toBeNull();
    store.dispatch(popTimelineRange());
    expect(history.location.pathname).toBe(DRIVE);
  });

  it('restores zoom predecessors with browser Back and Forward', () => {
    const { history, store } = create(DRIVE);
    store.dispatch(pushTimelineRange(LOG, 0, 10000));
    store.dispatch(pushTimelineRange(LOG, 123, 456));
    expect(history.location.pathname).toBe(`${DRIVE}/0.123/0.456`);
    history.goBack();
    expect(store.getState().zoom).toMatchObject({ start: 0, end: 10000, previous: { start: 0, end: 60000 } });
    history.goForward();
    expect(store.getState().zoom).toMatchObject({ start: 123, end: 456, previous: { start: 0, end: 10000 } });
  });

  it('reuses the dashboard list while loading an uncached drive', async () => {
    const { history, store } = create();
    const list = store.getState().routes;
    const missingLog = '2026-08-06--14-00-00';
    history.push(`/${DEVICE}/${missingLog}`);
    expect(api.routes.getRoutesSegments).toHaveBeenCalledWith(DEVICE, undefined, undefined, undefined, `${DEVICE}|${missingLog}`);
    store.dispatch({ type: ACTION_ROUTES_METADATA, dongleId: DEVICE, routeId: missingLog,
      routes: [{ ...route, fullname: `${DEVICE}|${missingLog}`, log_id: missingLog }] });
    expect(store.getState().currentRoute.log_id).toBe(missingLog);
    expect(store.getState().routes).toBe(list);
    history.goBack();
    expect(store.getState().selectedRouteId).toBeNull();
    expect(store.getState().routes).toBe(list);
  });

  it.each([null, { start: 0, end: 60000 }])('grows only a whole-drive URL (%j)', (range) => {
    const { store } = create(range ? `${DRIVE}/0/60` : DRIVE);
    store.dispatch({ type: 'ACTION_SEEK', offset: 10000 });
    store.dispatch({ type: ACTION_ROUTES_METADATA, dongleId: DEVICE, routeId: LOG,
      routes: [{ ...route, duration: 90000 }] });
    expect(store.getState().zoom.end).toBe(range ? 60000 : 90000);
    expect(store.getState().offset).toBe(10000);
  });

  it('zooms back to a fixed full-duration selection without turning it into a whole drive', () => {
    const { history, store } = create(`${DRIVE}/0/60`);
    store.dispatch(pushTimelineRange(LOG, 10000, 20000));
    store.dispatch(popTimelineRange());
    expect(history.location.pathname).toBe(`${DRIVE}/0/60`);
    expect(store.getState().navigation.range).toEqual({ start: 0, end: 60000 });
  });

  it('zooms back to a growing whole drive at its new duration', () => {
    const { history, store } = create(DRIVE);
    store.dispatch(pushTimelineRange(LOG, 10000, 20000));
    store.dispatch({ type: ACTION_ROUTES_METADATA, dongleId: DEVICE, routeId: LOG,
      routes: [{ ...route, duration: 90000 }] });
    store.dispatch(popTimelineRange());
    expect(history.location.pathname).toBe(DRIVE);
    expect(store.getState().zoom).toMatchObject({ start: 0, end: 90000 });
  });

  it('extends a whole-drive loop that starts at the first video frame', () => {
    const { store } = create(DRIVE);
    store.dispatch({ type: ACTION_ROUTES_METADATA, dongleId: DEVICE, routeId: LOG,
      routes: [{ ...route, videoStartOffset: 500 }] });
    expect(store.getState().loop).toEqual({ startTime: 500, duration: 59500 });
    store.dispatch({ type: ACTION_ROUTES_METADATA, dongleId: DEVICE, routeId: LOG,
      routes: [{ ...route, videoStartOffset: 500, duration: 90000 }] });
    expect(store.getState().loop).toEqual({ startTime: 500, duration: 89500 });
  });

  it('hydrates a refreshed zoom stack from browser history state', () => {
    const previousZoom = { start: 0, end: 60000, wholeDrive: true, previous: null };
    const state = createInitialState({ pathname: `${DRIVE}/10/20`, state: { previousZoom } });
    expect(state.zoom).toMatchObject({ start: 10000, end: 20000, previous: previousZoom });
  });

  it('does not redirect after a stale legacy URL lookup completes', async () => {
    let resolve;
    api.routes.getRoutesSegments.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const { history } = create(`/${DEVICE}/1000/2000`);
    history.push(`/${DEVICE}`);
    resolve([{ fullname: route.fullname, start_time_utc_millis: 1000, end_time_utc_millis: 2000 }]);
    await Promise.resolve();
    expect(history.location.pathname).toBe(`/${DEVICE}`);
  });

  it('replaces a legacy URL while preserving its selected interval and query', async () => {
    api.routes.getRoutesSegments.mockResolvedValueOnce([
      { fullname: route.fullname, start_time_utc_millis: 1000, end_time_utc_millis: 61000 },
    ]);
    const { history } = create(`/${DEVICE}/1100/1500?x=1#video`);
    await Promise.resolve();
    expect(history.location).toMatchObject({ pathname: `${DRIVE}/0.1/0.5`, search: '?x=1', hash: '#video' });
    expect(history.length).toBe(1);
  });
});
