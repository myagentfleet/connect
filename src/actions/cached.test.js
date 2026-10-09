import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/backend';
import { reverseLookup } from '../utils/geocode';
import * as Types from './types';

vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));
vi.mock('../store', () => ({ default: { getState: vi.fn() } }));
vi.mock('../utils/geocode', () => ({ reverseLookup: vi.fn() }));
vi.mock('../api/backend', () => ({
  api: { routeAssets: { events: vi.fn(), coords: vi.fn() } },
}));

const route = { fullname: '0000aaaa0000aaaa|00000001--0000000001', duration: 60000, maxqlog: 0 };
const location = { place: 'Little Italy', details: 'San Diego, CA' };
let actions;
let reducer;

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal('indexedDB', undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.routeAssets.events.mockReturnValue('https://route.example/0/events.json');
  api.routeAssets.coords.mockReturnValue('https://route.example/0/coords.json');
  reverseLookup.mockResolvedValue(location);
  vi.stubGlobal('fetch', vi.fn(async (url) => ({
    ok: true,
    json: async () => url.pathname.endsWith('events.json')
      ? [{ type: 'event', route_offset_millis: 100, data: { event_type: 'first_road_camera_frame' } }]
      : [{ t: 100, lng: -117, lat: 32 }],
  })));
  actions = await import('./cached');
  reducer = (await import('../reducers/globalState')).default;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createStore(routes = [route]) {
  const [dongleId, selectedRouteId] = routes[0].fullname.split('|');
  let state = {
    routes, lastRoutes: null, currentRoute: routes[0],
    dongleId, selectedRouteId, navigation: { range: null },
    deviceCache: {}, routeCacheRevisions: {}, routeLoadStatus: {},
    routeCache: Object.fromEntries(routes.map((item) => [item.fullname, item])),
  };
  const getState = () => state;
  const dispatch = vi.fn((action) => {
    if (typeof action === 'function') return action(dispatch, getState);
    state = reducer(state, action);
    return action;
  });
  return { dispatch, getState, setState: (next) => { state = next; } };
}

function updateMetadata(store, nextRoute, revision) {
  const [dongleId, routeId] = route.fullname.split('|');
  store.dispatch({ type: Types.ACTION_ROUTES_METADATA, dongleId, routeId, revision,
    routes: nextRoute ? [nextRoute] : [] });
}

async function expectSettled(promises) {
  let settled = false;
  const result = Promise.allSettled(promises).then((values) => {
    settled = true;
    return values;
  });
  await vi.runAllTimersAsync();
  expect(settled).toBe(true);
  expect((await result).every((value) => value.status === 'fulfilled')).toBe(true);
}

async function loadRouteData(state) {
  const dispatch = vi.fn();
  const getState = () => state;
  await Promise.all([
    actions.fetchEvents(route)(dispatch, getState),
    actions.fetchDriveCoords(route)(dispatch, getState),
    actions.fetchCoord(route, [-117, 32], 'startLocation')(dispatch, getState),
  ]);
  return dispatch;
}

describe('loaded route assets', () => {
  it.each([
    ['route cache', { routes: null, routeCache: { [route.fullname]: route } }],
    ['current route', { routes: null, currentRoute: route }],
    ['dashboard list', { routes: [route] }],
  ])('loads events, map coordinates and labels from the %s', async (_name, state) => {
    const dispatch = await loadRouteData(state);
    expect(api.routeAssets.events).toHaveBeenCalledExactlyOnceWith(route, 0);
    expect(api.routeAssets.coords).toHaveBeenCalledExactlyOnceWith(route, 0);
    expect(reverseLookup).toHaveBeenCalledExactlyOnceWith([-117, 32]);
    expect(dispatch).toHaveBeenCalledWith({
      type: Types.ACTION_UPDATE_ROUTE_EVENTS, fullname: route.fullname, maxqlog: route.maxqlog,
      events: [expect.objectContaining({ type: 'event', route_offset_millis: 100 })],
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: Types.ACTION_UPDATE_ROUTE, fullname: route.fullname, maxqlog: route.maxqlog,
      route: { driveCoords: { 100: [-117, 32] } },
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: Types.ACTION_UPDATE_ROUTE_LOCATION, fullname: route.fullname, locationKey: 'startLocation', location,
    });
  });

  it('reuses populated route-cache fields even when the dashboard copy is stale', async () => {
    const dispatch = await loadRouteData({
      routes: [route],
      routeCache: { [route.fullname]: { ...route, events: [], driveCoords: {}, startLocation: location } },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(reverseLookup).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not confuse identical drive IDs from different devices', async () => {
    const other = { ...route, fullname: route.fullname.replace('0000aaaa0000aaaa', '1111bbbb1111bbbb') };
    const dispatch = await loadRouteData({
      routes: [other], currentRoute: other, routeCache: { [other.fullname]: other },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(reverseLookup).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not load assets for a known missing drive from an older list copy', async () => {
    const dispatch = await loadRouteData({ routes: [route], routeCache: { [route.fullname]: null } });
    expect(fetch).not.toHaveBeenCalled();
    expect(reverseLookup).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe.each([
  ['events', 'fetchEvents', 'events', [{ type: 'event', data: {}, route_offset_millis: 100 }]],
  ['drive coordinates', 'fetchDriveCoords', 'driveCoords', [{ t: 100, lng: -117, lat: 32 }]],
])('%s request lifecycle', (_name, actionName, field, data) => {
  it.each(['network', 'HTTP', 'JSON', 'shape', 'processing'])('settles all waiters and retries after a %s failure', async (failure) => {
    const success = { ok: true, json: async () => data };
    fetch.mockReset();
    if (failure === 'network') fetch.mockRejectedValueOnce(new Error('offline'));
    else fetch.mockResolvedValueOnce({
      ok: failure !== 'HTTP', status: 503,
      json: async () => {
        if (failure === 'JSON') throw new SyntaxError('invalid JSON');
        return failure === 'shape' ? {} : [field === 'events' ? null : {}];
      },
    });
    fetch.mockResolvedValue(success);
    const store = createStore();
    await expectSettled([
      store.dispatch(actions[actionName](route)),
      store.dispatch(actions[actionName](route)),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.getState().routeCache[route.fullname][field]).toBeUndefined();

    await store.dispatch(actions[actionName](route));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.getState().routeCache[route.fullname][field]).toBeDefined();
    await store.dispatch(actions[actionName](route));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('deduplicates successful empty arrays and reuses them as loaded data', async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => [] });
    const store = createStore();
    await expectSettled([
      store.dispatch(actions[actionName](route)),
      store.dispatch(actions[actionName](route)),
    ]);
    expect(store.getState().routeCache[route.fullname][field]).toEqual(field === 'events' ? [] : {});
    await store.dispatch(actions[actionName](route));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps pending work scoped to each store and its route metadata', async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => data });
    const newerRoute = { ...route, maxqlog: 1 };
    const first = createStore();
    const second = createStore([newerRoute]);
    await expectSettled([
      first.dispatch(actions[actionName](route)),
      second.dispatch(actions[actionName](newerRoute)),
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(first.getState().routeCache[route.fullname][field]).toBeDefined();
    expect(second.getState().routeCache[route.fullname][field]).toBeDefined();
  });

  it.each([false, true])('keeps late results on their original route (missing: %s)', async (missing) => {
    let resolve;
    fetch.mockReturnValue(new Promise((done) => { resolve = done; }));
    const other = { ...route, fullname: route.fullname.replace('0000aaaa0000aaaa', '1111bbbb1111bbbb') };
    const store = createStore([route, other]);
    const pending = store.dispatch(actions[actionName](route));
    await vi.runAllTimersAsync();
    store.setState({ ...store.getState(), currentRoute: other, routes: [other],
      routeCache: { [route.fullname]: missing ? null : route, [other.fullname]: other } });
    resolve({ ok: true, json: async () => data });
    await pending;
    expect(store.getState().currentRoute).toBe(other);
    expect(store.getState().routeCache[other.fullname]).toBe(other);
    const cached = store.getState().routeCache[route.fullname];
    expect(cached === null).toBe(missing);
    expect(cached?.[field] !== undefined).toBe(!missing);
  });

  it.each(['old-first', 'new-first'])('isolates overlapping asset versions (%s)', async (order) => {
    const responses = [];
    fetch.mockImplementation(() => new Promise((resolve) => { responses.push(resolve); }));
    const store = createStore();
    const oldRequest = store.dispatch(actions[actionName](route));
    await vi.runAllTimersAsync();
    updateMetadata(store, { ...route, maxqlog: 1 }, 1);
    // A component may still hold the old route object when it requests assets.
    const newRequest = store.dispatch(actions[actionName](route));
    const duplicate = store.dispatch(actions[actionName](route));
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(3);
    const completeOld = async () => {
      responses[0]({ ok: true, json: async () => [] });
      await oldRequest;
    };
    const completeNew = async () => {
      responses[1]({ ok: true, json: async () => data });
      responses[2]({ ok: true, json: async () => [] });
      await Promise.all([newRequest, duplicate]);
    };
    const completions = order === 'old-first' ? [completeOld, completeNew] : [completeNew, completeOld];
    await completions[0]();
    const firstResult = store.getState().routeCache[route.fullname][field];
    expect(firstResult !== undefined).toBe(order === 'new-first');
    await completions[1]();
    const finalResult = store.getState().routeCache[route.fullname][field];
    expect(Object.keys(finalResult)).toHaveLength(1);
    expect(order === 'old-first' || finalResult === firstResult).toBe(true);
    expect(store.getState().routeCache[route.fullname].maxqlog).toBe(1);
  });

  it('retains assets for unchanged metadata and reloads them after maxqlog grows', async () => {
    const store = createStore();
    await store.dispatch(actions[actionName](route));
    const cached = store.getState().routeCache[route.fullname];
    updateMetadata(store, { ...route, duration: 65000 }, 1);
    expect(store.getState().routeCache[route.fullname][field]).toBe(cached[field]);
    await store.dispatch(actions[actionName](route));
    expect(fetch).toHaveBeenCalledTimes(1);

    updateMetadata(store, { ...route, maxqlog: 1, duration: 120000 }, 2);
    expect(store.getState().routeCache[route.fullname][field]).toBeUndefined();
    expect(store.getState().routeCache[route.fullname].videoStartOffset).toBeUndefined();
    // An older metadata response must not restore the invalidated asset version.
    updateMetadata(store, cached, 1);
    expect(store.getState().routeCache[route.fullname].maxqlog).toBe(1);
    await store.dispatch(actions[actionName](route));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(store.getState().routeCache[route.fullname][field]).toBeDefined();
  });

  it('does not revive a missing route when either asset version finishes', async () => {
    const responses = [];
    fetch.mockImplementation(() => new Promise((resolve) => { responses.push(resolve); }));
    const store = createStore();
    const oldRequest = store.dispatch(actions[actionName](route));
    await vi.runAllTimersAsync();
    updateMetadata(store, { ...route, maxqlog: 1 }, 1);
    const newRequest = store.dispatch(actions[actionName](route));
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(3);
    updateMetadata(store, null, 2);
    responses.forEach((resolve) => resolve({ ok: true, json: async () => data }));
    await Promise.all([oldRequest, newRequest]);
    expect(store.getState().routeCache[route.fullname]).toBeNull();
    expect(store.getState().currentRoute).toBeNull();
  });
});

describe('reverse lookup request lifecycle', () => {
  it.each(['null', 'rejection'])('settles coordinate waiters after %s and permits retry', async (failure) => {
    if (failure === 'null') reverseLookup.mockResolvedValueOnce(null);
    else reverseLookup.mockRejectedValueOnce(new Error('lookup failed'));
    const other = { ...route, fullname: route.fullname.replace('0000aaaa0000aaaa', '1111bbbb1111bbbb') };
    const store = createStore([route, other]);
    const load = () => [
      store.dispatch(actions.fetchCoord(route, [-117.1234, 32.1234], 'startLocation')),
      store.dispatch(actions.fetchCoord(other, [-117.12349, 32.12349], 'endLocation')),
    ];
    await expectSettled(load());
    expect(reverseLookup).toHaveBeenCalledTimes(1);
    expect(store.getState().routeCache[route.fullname].startLocation).toBeUndefined();
    expect(store.getState().routeCache[other.fullname].endLocation).toBeUndefined();
    await expectSettled(load());
    expect(reverseLookup).toHaveBeenCalledTimes(2);
    expect(reverseLookup).toHaveBeenLastCalledWith([-117.123, 32.123]);
    expect(store.getState().routeCache[route.fullname].startLocation).toEqual(location);
    expect(store.getState().routeCache[other.fullname].endLocation).toEqual(location);
    await expectSettled(load());
    expect(reverseLookup).toHaveBeenCalledTimes(2);
  });
});

describe('persistent asset cache', () => {
  it.each([0, 1])('reuses only the matching persisted asset version (%s)', async (version) => {
    const cachedEvents = [{ type: 'event', data: { event_type: 'cached' }, route_offset_millis: 50 }];
    const request = (result) => {
      const pending = {};
      Promise.resolve().then(() => pending.onsuccess({ target: { result } }));
      return pending;
    };
    const db = {
      objectStoreNames: { contains: () => true },
      transaction: () => ({ objectStore: () => ({
        get: () => request({ version, data: cachedEvents }),
        put: () => request(undefined),
        index: () => ({ openCursor: () => request(null) }),
      }) }),
    };
    vi.stubGlobal('indexedDB', { open: () => request(db) });
    vi.stubGlobal('IDBKeyRange', { upperBound: vi.fn() });
    const store = createStore();
    await expectSettled([store.dispatch(actions.fetchEvents(route))]);
    expect(fetch).toHaveBeenCalledTimes(version === route.maxqlog ? 0 : 1);
    expect(store.getState().routeCache[route.fullname].events[0].data.event_type)
      .toBe(version === route.maxqlog ? 'cached' : 'first_road_camera_frame');
  });

  it.each(['read', 'write'])('keeps loaded assets usable after a cache %s failure', async (operation) => {
    const error = new Error(`cache ${operation} failed`);
    const request = (result, failed = false) => {
      const pending = {};
      Promise.resolve().then(() => {
        if (failed) pending.onerror({ target: { error } });
        else pending.onsuccess({ target: { result } });
      });
      return pending;
    };
    const db = {
      objectStoreNames: { contains: () => true },
      transaction: () => ({ objectStore: () => ({
        get: () => request(undefined, operation === 'read'),
        put: () => request(undefined, operation === 'write'),
        index: () => ({ openCursor: () => request(null) }),
      }) }),
    };
    vi.stubGlobal('indexedDB', { open: () => request(db) });
    vi.stubGlobal('IDBKeyRange', { upperBound: vi.fn() });
    const store = createStore();
    await expectSettled([
      store.dispatch(actions.fetchEvents(route)),
      store.dispatch(actions.fetchEvents(route)),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.getState().routeCache[route.fullname].events).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(error);
    await store.dispatch(actions.fetchEvents(route));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
