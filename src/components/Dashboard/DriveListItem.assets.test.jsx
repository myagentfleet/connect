import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { connect, Provider } from 'react-redux';
import { applyMiddleware, createStore } from 'redux';
import thunk from 'redux-thunk';

import DriveListItem from './DriveListItem';
import globalState from '../../reducers/globalState';
import { reverseLookup } from '../../utils/geocode';

vi.mock('../Timeline', () => ({ default: () => null }));
vi.mock('../../timeline', () => ({ currentOffset: () => 0 }));
vi.mock('../../utils/geocode', () => ({ reverseLookup: vi.fn() }));
vi.mock('../../api/backend', () => ({ api: { routeAssets: {
  events: (_route, segment) => `https://route.example/${segment}/events.json`,
} } }));

const location = { place: 'San Diego' };
const route = {
  fullname: 'aaaaaaaaaaaaaaaa|2026-08-06--12-00-00', dongle_id: 'aaaaaaaaaaaaaaaa', log_id: '2026-08-06--12-00-00',
  maxqlog: 0, distance: 1, duration: 60000, start_time_utc_millis: 0, end_time_utc_millis: 60000,
  start_lng: -117, start_lat: 32, end_lng: -118, end_lat: 33, startLocation: location, endLocation: location,
};
const Row = connect(state => ({ drive: state.routes[0] }))(DriveListItem);

function renderRow(drive, knownMissing = false) {
  const initial = { routes: [drive], currentRoute: null, lastRoutes: null,
    routeCache: { [drive.fullname]: knownMissing ? null : drive } };
  const store = createStore((state = initial, action) => action.type === 'replace-route'
    ? { ...state, routes: [action.route], routeCache: { [drive.fullname]: action.route } }
    : globalState(state, action), applyMiddleware(thunk));
  const view = render(<Provider store={store}><Row /></Provider>);
  return { ...view, store, replaceRoute: value => act(() => store.dispatch({ type: 'replace-route', route: value })) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('indexedDB', undefined);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: { height: 500 } });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('a visible row refetches invalidated events after growth without reloading same-version assets', async () => {
  const app = renderRow({ ...route, events: [] });
  expect(fetch).not.toHaveBeenCalled();
  app.replaceRoute({ ...route, maxqlog: 1, duration: 120000 });
  await waitFor(() => expect(app.store.getState().routes[0].events).toEqual([]));
  expect(fetch).toHaveBeenCalledTimes(2);
  const loaded = app.store.getState().routes[0];
  app.replaceRoute({ ...loaded, is_public: true });
  expect(app.store.getState().routes[0].events).toBe(loaded.events);
  expect(app.store.getState().routes[0].startLocation).toBe(location);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(reverseLookup).not.toHaveBeenCalled();
});

test('an offscreen row waits until visible, then loads the latest route version', async () => {
  let y = 1000;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ y }));
  const app = renderRow(route);
  app.replaceRoute({ ...route, maxqlog: 1, duration: 120000 });
  expect(fetch).not.toHaveBeenCalled();
  y = 0;
  fireEvent.scroll(window);
  await waitFor(() => expect(app.store.getState().routes[0].events).toEqual([]));
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('a stale visible list row cannot fetch assets for a known missing route', async () => {
  renderRow(route, true);
  await act(async () => {});
  expect(fetch).not.toHaveBeenCalled();
  expect(reverseLookup).not.toHaveBeenCalled();
});
