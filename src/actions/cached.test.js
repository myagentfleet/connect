import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/backend';
import { reverseLookup } from '../utils/geocode';
import * as Types from './types';

vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));
vi.mock('../utils/geocode', () => ({ reverseLookup: vi.fn() }));
vi.mock('../api/backend', () => ({
  api: { routeAssets: { events: vi.fn(), coords: vi.fn() } },
}));

const route = { fullname: '0000aaaa0000aaaa|00000001--0000000001', duration: 60000, maxqlog: 0 };
const location = { place: 'Little Italy', details: 'San Diego, CA' };
let actions;

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal('indexedDB', undefined);
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
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
      type: Types.ACTION_UPDATE_ROUTE_EVENTS, fullname: route.fullname,
      events: [expect.objectContaining({ type: 'event', route_offset_millis: 100 })],
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: Types.ACTION_UPDATE_ROUTE, fullname: route.fullname,
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
