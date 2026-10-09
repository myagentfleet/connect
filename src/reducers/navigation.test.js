import { describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../initialState';
import { parseLocation } from '../url';
import * as Types from '../actions/types';
import rootReducer from '.';

vi.mock('../store', () => ({ default: { getState: vi.fn() } }));

const DEVICE = 'aaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbb';
const LOG = '2026-08-06--12-00-00';
const route = { fullname: `${DEVICE}|${LOG}`, log_id: LOG, duration: 60000 };
const secondRoute = { ...route, fullname: `${DEVICE}|2026-08-06--13-00-00`, log_id: '2026-08-06--13-00-00' };
const otherRoute = { ...route, fullname: `${OTHER}|${LOG}` };
const location = { place: 'Little Italy', details: 'San Diego, CA' };

function createState() {
  return {
    ...createInitialState({ pathname: `/${DEVICE}` }),
    devices: [{ dongle_id: DEVICE }, { dongle_id: OTHER }],
    routes: [route, secondRoute],
    lastRoutes: [route],
    routeCache: { [route.fullname]: route, [secondRoute.fullname]: secondRoute },
  };
}

function navigate(state, pathname) {
  return rootReducer(state, { type: Types.ACTION_NAVIGATE, navigation: parseLocation(pathname) });
}

describe('canonical route data in retained lists', () => {
  it.each([
    ['events', { type: Types.ACTION_UPDATE_ROUTE_EVENTS, events: [] }, { events: [] }],
    ['labels', { type: Types.ACTION_UPDATE_ROUTE_LOCATION, locationKey: 'startLocation', location }, { startLocation: location }],
    ['coordinates', { type: Types.ACTION_UPDATE_ROUTE, route: { driveCoords: { 100: [-117, 32] } } }, { driveCoords: { 100: [-117, 32] } }],
    ['metadata', { type: Types.ACTION_ROUTES_METADATA, dongleId: DEVICE, routeId: LOG, routes: [{ ...route, duration: 120000 }] }, { duration: 120000 }],
  ])('restores %s received while another device is active', (_name, action, expected) => {
    const initial = createState();
    let state = navigate(initial, `/${OTHER}`);
    state = rootReducer(state, {
      type: Types.ACTION_ROUTES_METADATA, dongleId: OTHER, routeId: null,
      routes: [otherRoute], limit: state.limit, ...state.filter,
    });
    const otherList = state.routes;
    expect(otherList).toEqual([otherRoute]);
    state = rootReducer(state, { ...action, fullname: route.fullname });
    expect(state.routes).toBe(otherList);

    state = navigate(state, `/${DEVICE}`);
    const cached = state.routeCache[route.fullname];
    expect(cached).toMatchObject(expected);
    expect(state.routes[0]).toBe(cached);
    expect(state.lastRoutes[0]).toBe(cached);
    expect(state.routes[1]).toBe(secondRoute);
    expect(state.routes).toHaveLength(initial.routes.length);
    expect(state.filter).toBe(initial.filter);
  });

  it('preserves both list identities when returning to unchanged route data', () => {
    const initial = createState();
    const state = navigate(navigate(initial, `/${OTHER}`), `/${DEVICE}`);
    expect(state.routes).toBe(initial.routes);
    expect(state.lastRoutes).toBe(initial.lastRoutes);
  });

  it('updates the fallback list when an asset arrives during a date-filter request', () => {
    let state = rootReducer(createState(), { type: Types.ACTION_SELECT_TIME_FILTER, start: 1000, end: 2000 });
    state = rootReducer(state, {
      type: Types.ACTION_UPDATE_ROUTE_LOCATION, fullname: route.fullname,
      locationKey: 'startLocation', location,
    });
    expect(state.routes).toBeNull();
    expect(state.lastRoutes[0]).toBe(state.routeCache[route.fullname]);
    expect(state.lastRoutes[0].startLocation).toEqual(location);
    expect(state.lastRoutes[1]).toBe(secondRoute);
  });

  it('keeps the dashboard list current without replacing its membership on a drive response', () => {
    let state = navigate(createState(), `/${DEVICE}/${LOG}`);
    state = rootReducer(state, {
      type: Types.ACTION_ROUTES_METADATA, dongleId: DEVICE, routeId: LOG,
      routes: [{ ...route, duration: 120000 }],
    });
    expect(state.currentRoute).toBe(state.routeCache[route.fullname]);
    expect(state.routes[0]).toBe(state.currentRoute);
    expect(state.lastRoutes[0]).toBe(state.currentRoute);
    expect(state.routes[1]).toBe(secondRoute);
    expect(state.routes).toHaveLength(2);
  });

  it('preserves active list identities when an unlisted route is updated', () => {
    const initial = createState();
    initial.routeCache[otherRoute.fullname] = otherRoute;
    const state = rootReducer(initial, {
      type: Types.ACTION_UPDATE_ROUTE_EVENTS, fullname: otherRoute.fullname, events: [],
    });
    expect(state.routes).toBe(initial.routes);
    expect(state.lastRoutes).toBe(initial.lastRoutes);
    expect(state.routeCache[otherRoute.fullname].events).toEqual([]);
  });

  it.each([false, true])('keeps a missing drive out of retained lists after late events (inactive: %s)', (inactive) => {
    let state = navigate(createState(), `/${DEVICE}/${LOG}`);
    if (inactive) state = navigate(state, `/${OTHER}`);
    state = rootReducer(state, {
      type: Types.ACTION_ROUTES_METADATA, dongleId: DEVICE, routeId: LOG, routes: [], revision: 1,
    });
    state = rootReducer(state, {
      type: Types.ACTION_UPDATE_ROUTE_EVENTS, fullname: route.fullname, events: [],
    });
    expect(state.routeCache[route.fullname]).toBeNull();

    if (inactive) state = navigate(state, `/${DEVICE}/${LOG}`);
    expect(state.currentRoute).toBeNull();
    expect(state.routes).toEqual([secondRoute]);
    expect(state.lastRoutes).toEqual([]);
  });
});
