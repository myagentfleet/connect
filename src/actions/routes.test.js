import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react';
import { api } from '../api/backend';
import { hardNavigate } from '../utils/navigation';
import { createInitialState } from '../initialState';
import { parseLocation } from '../url';
import rootReducer from '../reducers';
import { checkLastRoutesData, checkRoutesData } from './routes';
import * as Types from './types';

vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));
vi.mock('../utils/navigation', () => ({ hardNavigate: vi.fn() }));
vi.mock('../store', () => ({ default: { getState: vi.fn() } }));
vi.mock('../api/backend', () => ({
  api: {
    auth: { isAuthenticated: vi.fn() },
    routes: { getRoutesSegments: vi.fn() },
  },
}));

const DEVICE = '0000aaaa0000aaaa';
const OTHER_DEVICE = '1111bbbb1111bbbb';
const DRIVE = '00000001--0000000001';
const OTHER_DRIVE = '00000002--0000000002';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function rawRoute(dongleId = DEVICE, routeId = DRIVE, fields = {}) {
  return {
    fullname: `${dongleId}|${routeId}`,
    url: 'https://chffrprivate.blob.core.windows.net/route',
    create_time: 1,
    start_time_utc_millis: 1000,
    end_time_utc_millis: 61000,
    segment_numbers: [0],
    segment_start_times: [1000],
    segment_end_times: [61000],
    ...fields,
  };
}

function harness(fields = {}) {
  const routeId = Object.hasOwn(fields, 'selectedRouteId') ? fields.selectedRouteId : DRIVE;
  const pathname = `/${fields.dongleId || DEVICE}${routeId ? '/' + routeId : ''}`;
  const location = fields.router?.location || { pathname, search: '', hash: '' };
  let state = {
    ...createInitialState(location),
    router: { location },
    devices: [{ dongle_id: DEVICE }, { dongle_id: OTHER_DEVICE }],
    filter: { start: 0, end: 100000 },
    limit: 5,
    ...fields,
  };
  const getState = () => state;
  const dispatch = vi.fn((action) => {
    if (typeof action === 'function') return action(dispatch, getState);
    state = rootReducer(state, action);
    return action;
  });
  return {
    dispatch, getState,
    load: (options) => checkRoutesData(options)(dispatch, getState),
    loadLast: () => checkLastRoutesData()(dispatch, getState),
    metadata: () => dispatch.mock.calls.map(([action]) => action).filter(({ type }) => type === Types.ACTION_ROUTES_METADATA),
    select: (changes) => {
      if (changes.dongleId || Object.hasOwn(changes, 'selectedRouteId')) {
        const selected = Object.hasOwn(changes, 'selectedRouteId') ? changes.selectedRouteId : state.selectedRouteId;
        const path = `/${changes.dongleId || state.dongleId}${selected ? '/' + selected : ''}`;
        const nextLocation = { pathname: path, search: '', hash: '' };
        state = { ...state, router: { location: nextLocation } };
        dispatch({ type: Types.ACTION_NAVIGATE, navigation: parseLocation(nextLocation) });
      }
      if (changes.filter) dispatch({ type: Types.ACTION_SELECT_TIME_FILTER, ...changes.filter });
      if (changes.limit !== undefined) dispatch({ type: Types.ACTION_UPDATE_ROUTE_LIMIT, limit: changes.limit });
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.auth.isAuthenticated.mockReturnValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('route metadata requests', () => {
  it('fetches an uncached drive by full name and returns the same pending promise', async () => {
    const response = deferred();
    api.routes.getRoutesSegments.mockReturnValue(response.promise);
    const store = harness();
    const pending = store.load();
    expect(store.load()).toBe(pending);
    expect(api.routes.getRoutesSegments).toHaveBeenCalledExactlyOnceWith(
      DEVICE, undefined, undefined, undefined, `${DEVICE}|${DRIVE}`,
    );
    response.resolve([rawRoute()]);
    expect(await pending).toEqual([expect.objectContaining({ log_id: DRIVE, duration: 60000 })]);
    expect(store.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: Types.ACTION_ROUTES_METADATA, dongleId: DEVICE, routeId: DRIVE,
    }));
  });

  it.each([
    ['drive', { selectedRouteId: OTHER_DRIVE }],
    ['device', { dongleId: OTHER_DEVICE }],
    ['filter', { filter: { start: 10, end: 100000 } }],
    ['limit', { limit: 10 }],
  ])('caches an earlier %s response without releasing or changing the active request', async (_name, selection) => {
    const oldResponse = deferred();
    const newResponse = deferred();
    api.routes.getRoutesSegments.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
    const store = harness();
    const oldPending = store.load();
    store.select(selection);
    const newPending = store.load();
    const navigation = store.getState().navigation;
    expect(newPending).not.toBe(oldPending);

    oldResponse.resolve([rawRoute()]);
    await oldPending;
    expect(store.getState().routeCache[`${DEVICE}|${DRIVE}`]).toBeDefined();
    expect(store.getState().navigation).toBe(navigation);
    expect(store.load()).toBe(newPending);
    expect(api.routes.getRoutesSegments).toHaveBeenCalledTimes(2);

    const dongleId = selection.dongleId || DEVICE;
    const routeId = selection.selectedRouteId || DRIVE;
    newResponse.resolve([rawRoute(dongleId, routeId)]);
    await newPending;
    expect(store.metadata()).toHaveLength(2);
    expect(store.getState().currentRoute.fullname).toBe(`${dongleId}|${routeId}`);
    store.select({ dongleId: DEVICE, selectedRouteId: DRIVE });
    expect(store.load()).toBeUndefined();
    expect(api.routes.getRoutesSegments).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['drive', { selectedRouteId: OTHER_DRIVE }, { selectedRouteId: DRIVE }],
    ['device', { dongleId: OTHER_DEVICE }, { dongleId: DEVICE }],
  ])('reuses the pending request after navigating to another %s and back', async (_name, away, back) => {
    const first = deferred();
    const second = deferred();
    api.routes.getRoutesSegments.mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const store = harness();
    const firstPending = store.load();
    store.select(away);
    const secondPending = store.load();
    store.select(back);
    expect(store.load()).toBe(firstPending);
    expect(api.routes.getRoutesSegments).toHaveBeenCalledTimes(2);
    first.resolve([rawRoute()]);
    second.resolve([rawRoute(away.dongleId || DEVICE, away.selectedRouteId || DRIVE)]);
    await Promise.all([firstPending, secondPending]);
    expect(store.metadata()).toHaveLength(2);
    expect(store.getState().currentRoute.fullname).toBe(`${DEVICE}|${DRIVE}`);
  });

  it('does not share pending requests between stores', async () => {
    const response = deferred();
    api.routes.getRoutesSegments.mockReturnValue(response.promise);
    const first = harness();
    const second = harness();
    const requests = [first.load(), second.load()];
    expect(api.routes.getRoutesSegments).toHaveBeenCalledTimes(2);
    response.resolve([rawRoute()]);
    await Promise.all(requests);
    expect(first.metadata()).toHaveLength(1);
    expect(second.metadata()).toHaveLength(1);
  });

  it.each([
    ['route cache', { routeCache: { [`${DEVICE}|${DRIVE}`]: rawRoute() } }],
    ['dashboard list', { routes: [rawRoute()] }],
  ])('reuses an exact drive from the %s outside the dashboard filter', (_name, fields) => {
    harness(fields).load();
    expect(api.routes.getRoutesSegments).not.toHaveBeenCalled();
  });

  it('fetches a dashboard list with its date range and limit', async () => {
    api.routes.getRoutesSegments.mockResolvedValue([]);
    const store = harness({ selectedRouteId: null });
    await store.load();
    expect(api.routes.getRoutesSegments).toHaveBeenCalledExactlyOnceWith(DEVICE, 0, 100000, 5);
    expect(store.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: Types.ACTION_ROUTES_METADATA, dongleId: DEVICE, routeId: null,
      start: 0, end: 100000, limit: 5, revision: 1, routes: [],
    });
  });

  it('restores a dashboard response that completed while another device was active', async () => {
    const first = deferred();
    const second = deferred();
    api.routes.getRoutesSegments.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const store = harness({ selectedRouteId: null });
    const firstPending = store.load();
    store.select({ dongleId: OTHER_DEVICE, limit: 5 });
    const secondPending = store.load();
    second.resolve([rawRoute(OTHER_DEVICE)]);
    await secondPending;
    const otherList = store.getState().routes;

    first.resolve([rawRoute()]);
    await firstPending;
    expect(store.getState().routes).toBe(otherList);
    expect(store.getState().deviceCache[DEVICE].routes[0]).toBe(store.getState().routeCache[`${DEVICE}|${DRIVE}`]);
    store.select({ dongleId: DEVICE });
    expect(store.getState().routes[0].fullname).toBe(`${DEVICE}|${DRIVE}`);
    expect(store.getState().filter).toEqual({ start: 0, end: 100000 });
    expect(store.load()).toBeUndefined();
    expect(api.routes.getRoutesSegments).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['filter while active', { filter: { start: 10000, end: 20000 } }, false],
    ['filter while inactive', { filter: { start: 10000, end: 20000 } }, true],
    ['limit while active', { limit: 10 }, false],
    ['limit while inactive', { limit: 10 }, true],
  ])('does not replace dashboard membership with an older %s response', async (_name, selection, inactive) => {
    const first = deferred();
    const second = deferred();
    api.routes.getRoutesSegments.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const store = harness({ selectedRouteId: null });
    const firstPending = store.load();
    store.select(selection);
    const secondPending = store.load();
    second.resolve([rawRoute(DEVICE, OTHER_DRIVE)]);
    await secondPending;
    const list = store.getState().routes;
    if (inactive) store.select({ dongleId: OTHER_DEVICE });
    first.resolve([rawRoute()]);
    await firstPending;
    const retained = inactive ? store.getState().deviceCache[DEVICE].routes : store.getState().routes;
    expect(retained).toBe(list);
    expect(retained.map((route) => route.log_id)).toEqual([OTHER_DRIVE]);
    expect(store.getState().routeCache[`${DEVICE}|${DRIVE}`]).toBeDefined();
  });

  it.each(['older first', 'older last'])('keeps the newer shared entity across list and drive responses (%s)', async (order) => {
    const listResponse = deferred();
    const driveResponse = deferred();
    api.routes.getRoutesSegments.mockReturnValueOnce(listResponse.promise).mockReturnValueOnce(driveResponse.promise);
    const store = harness({ selectedRouteId: null });
    const listPending = store.load();
    store.select({ selectedRouteId: DRIVE });
    const drivePending = store.load();
    if (order === 'older first') {
      listResponse.resolve([rawRoute()]);
      await listPending;
    }
    driveResponse.resolve([rawRoute(DEVICE, DRIVE, { end_time_utc_millis: 121000, segment_end_times: [121000] })]);
    await drivePending;
    const current = store.getState().currentRoute;
    if (order === 'older last') {
      listResponse.resolve([rawRoute()]);
      await listPending;
    }
    expect(store.getState().currentRoute).toBe(current);
    expect(current.duration).toBe(120000);
    expect(store.getState().routes[0]).toBe(current);
    expect(store.getState().zoom.end).toBe(120000);
    expect(store.getState().routeCacheRevisions[current.fullname]).toBe(2);
  });

  it.each(['older first', 'older last'])('does not resurrect a newer missing drive from an older list (%s)', async (order) => {
    const listResponse = deferred();
    const driveResponse = deferred();
    api.routes.getRoutesSegments.mockReturnValueOnce(listResponse.promise).mockReturnValueOnce(driveResponse.promise);
    const store = harness({ selectedRouteId: null });
    const listPending = store.load();
    store.select({ selectedRouteId: DRIVE });
    const drivePending = store.load();
    if (order === 'older first') {
      listResponse.resolve([rawRoute()]);
      await listPending;
    }
    driveResponse.resolve([]);
    await drivePending;
    if (order === 'older last') {
      listResponse.resolve([rawRoute()]);
      await listPending;
    }
    expect(store.getState().routeCache[`${DEVICE}|${DRIVE}`]).toBeNull();
    expect(store.getState().currentRoute).toBeNull();
    expect(store.load()).toBeUndefined();
    expect(api.routes.getRoutesSegments).toHaveBeenCalledTimes(2);
  });

  it('loads a missing selected drive even when the retained dashboard list has reached its end', async () => {
    api.routes.getRoutesSegments.mockResolvedValue([rawRoute()]);
    const store = harness({ routes: [rawRoute(DEVICE, OTHER_DRIVE)], limit: 10 });
    await store.loadLast();
    expect(api.routes.getRoutesSegments).toHaveBeenCalledExactlyOnceWith(
      DEVICE, undefined, undefined, undefined, `${DEVICE}|${DRIVE}`,
    );
    expect(store.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: Types.ACTION_UPDATE_ROUTE_LIMIT }));
    expect(store.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: Types.ACTION_SELECT_TIME_FILTER }));
  });

  it('preserves boundary correction, legacy distance, CDN URLs, and route ordering', async () => {
    api.routes.getRoutesSegments.mockResolvedValue([
      rawRoute(),
      rawRoute(DEVICE, OTHER_DRIVE, {
        create_time: 2, length: 123,
        start_time_utc_millis: 100000000, end_time_utc_millis: 100090000,
        segment_numbers: [0, 1], segment_start_times: [0, 100060000], segment_end_times: [60000, 100090000],
      }),
    ]);
    const [latest, previous] = await harness({ selectedRouteId: null }).load();
    expect(latest).toMatchObject({
      log_id: OTHER_DRIVE, duration: 90000, distance: 123,
      start_time_utc_millis: 100000000, end_time_utc_millis: 100090000,
      segment_start_times: [100000000, 100060000], segment_end_times: [100060000, 100090000],
      segment_durations: [60000, 30000], url: 'https://chffrprivate.azureedge.net/route',
    });
    expect(previous.log_id).toBe(DRIVE);
  });

  it('preserves pathname, query and fragment in the missing public-drive login redirect', async () => {
    api.auth.isAuthenticated.mockReturnValue(false);
    api.routes.getRoutesSegments.mockResolvedValue([]);
    const location = { pathname: `/${DEVICE}/${DRIVE}`, search: '?dialog=downloads&mode=map', hash: '#video' };
    await harness({ router: { location } }).load();
    expect(hardNavigate).toHaveBeenCalledExactlyOnceWith(
      `/?r=${encodeURIComponent(location.pathname + location.search + location.hash)}`,
    );
  });

  it('does not redirect a private dialog that already requires sign-in', async () => {
    api.auth.isAuthenticated.mockReturnValue(false);
    api.routes.getRoutesSegments.mockResolvedValue([]);
    const location = { pathname: `/${DEVICE}/${DRIVE}`, search: '?dialog=settings', hash: '' };
    await harness({ router: { location } }).load();
    expect(hardNavigate).not.toHaveBeenCalled();
  });

  it('does not cache or redirect an empty anonymous response when its drive is no longer selected', async () => {
    api.auth.isAuthenticated.mockReturnValue(false);
    const response = deferred();
    api.routes.getRoutesSegments.mockReturnValue(response.promise);
    const store = harness();
    const pending = store.load();
    store.select({ selectedRouteId: OTHER_DRIVE });
    response.resolve([]);
    await pending;
    expect(store.metadata()).toHaveLength(0);
    expect(store.getState().routeCache[`${DEVICE}|${DRIVE}`]).toBeUndefined();
    expect(hardNavigate).not.toHaveBeenCalled();
  });

  it('retries a settled missing drive only when explicitly requested', async () => {
    api.routes.getRoutesSegments.mockResolvedValueOnce([]).mockResolvedValueOnce([rawRoute()]);
    const store = harness();
    await store.load();
    expect(store.getState().currentRoute).toBeNull();
    expect(store.getState().routeCache[`${DEVICE}|${DRIVE}`]).toBeNull();
    expect(store.load()).toBeUndefined();
    expect(api.routes.getRoutesSegments).toHaveBeenCalledOnce();
    await store.load({ retry: true });
    expect(store.getState().currentRoute.fullname).toBe(`${DEVICE}|${DRIVE}`);
    expect(api.routes.getRoutesSegments).toHaveBeenCalledTimes(2);
  });

  it('reports an active failure, stops automatic retries, and allows an explicit retry', async () => {
    const error = new Error('offline');
    api.routes.getRoutesSegments.mockRejectedValueOnce(error).mockResolvedValueOnce([rawRoute()]);
    const store = harness();
    await expect(store.load()).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalledWith(error, { fingerprint: 'timeline_fetch_routes' });
    expect(store.getState().routeLoadStatus[`${DEVICE}|${DRIVE}`]).toBe('error');
    await store.load();
    expect(api.routes.getRoutesSegments).toHaveBeenCalledOnce();
    await store.load({ retry: true });
    expect(api.routes.getRoutesSegments).toHaveBeenCalledTimes(2);
    expect(store.metadata()).toHaveLength(1);
    expect(store.getState().routeLoadStatus[`${DEVICE}|${DRIVE}`]).toBeUndefined();
  });

  it('does not let an older rejection release a newer pending request', async () => {
    const oldResponse = deferred();
    const newResponse = deferred();
    api.routes.getRoutesSegments.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
    const store = harness();
    const oldPending = store.load();
    store.select({ dongleId: OTHER_DEVICE });
    const newPending = store.load();
    oldResponse.reject(new Error('old request failed'));
    await oldPending;
    expect(store.load()).toBe(newPending);
    expect(store.getState().routeLoadStatus[`${OTHER_DEVICE}|${DRIVE}`]).toBe('loading');
    newResponse.resolve([rawRoute(OTHER_DEVICE)]);
    await newPending;
    expect(store.metadata()).toEqual([expect.objectContaining({ dongleId: OTHER_DEVICE })]);
  });
});
