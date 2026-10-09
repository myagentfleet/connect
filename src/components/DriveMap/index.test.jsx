import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { applyMiddleware, createStore } from 'redux';
import thunk from 'redux-thunk';

import DriveMap from '.';
import globalState from '../../reducers/globalState';

const sources = vi.hoisted(() => ({ route: { setData: vi.fn() }, seekPoint: { setData: vi.fn() } }));
vi.mock('react-map-gl', () => ({
  LinearInterpolator: class {},
  default: React.forwardRef((_props, ref) => {
    React.useImperativeHandle(ref, () => ({ getMap: () => ({
      on: (_event, callback) => callback(), addSource() {}, addLayer() {}, getSource: name => sources[name],
    }) }), []);
    return <div />;
  }),
}));
vi.mock('../../timeline', () => ({ currentOffset: () => 0 }));
vi.mock('../../api/backend', () => ({ api: { routeAssets: {
  coords: (_route, segment) => `https://route.example/${segment}/coords.json`,
} } }));

const route = { fullname: 'aaaaaaaaaaaaaaaa|2026-08-06--12-00-00', maxqlog: 0 };
const oldCoords = { 0: [-117, 32] };

function renderMap(currentRoute) {
  const initial = { currentRoute, routes: currentRoute ? [currentRoute] : [], lastRoutes: null,
    routeCache: currentRoute ? { [currentRoute.fullname]: currentRoute } : {} };
  const store = createStore((state = initial, action) => action.type === 'replace-route'
    ? { ...state, currentRoute: action.route, routes: action.route ? [action.route] : [],
      routeCache: { [route.fullname]: action.route } }
    : globalState(state, action), applyMiddleware(thunk));
  const view = render(<Provider store={store}><DriveMap /></Provider>);
  return { ...view, store, replaceRoute: value => act(() => store.dispatch({ type: 'replace-route', route: value })) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  vi.stubGlobal('indexedDB', undefined);
  vi.stubGlobal('fetch', vi.fn(async url => ({ ok: true, json: async () => [
    { t: Number(url.pathname.split('/')[1]) * 60, lng: -118, lat: 33 },
  ] })));
});

afterEach(() => { vi.unstubAllGlobals(); });

test('same-route growth clears stale geometry, loads the new version, and preserves same-version coordinates', async () => {
  const app = renderMap({ ...route, driveCoords: oldCoords });
  expect(fetch).not.toHaveBeenCalled();
  expect(sources.route.setData).toHaveBeenLastCalledWith(expect.objectContaining({
    geometry: { type: 'LineString', coordinates: Object.values(oldCoords) },
  }));
  app.replaceRoute({ ...route, maxqlog: 1 });
  expect(sources.route.setData).toHaveBeenLastCalledWith(expect.objectContaining({
    geometry: { type: 'LineString', coordinates: [] },
  }));
  await waitFor(() => expect(app.store.getState().currentRoute.driveCoords).toEqual({ 0: [-118, 33], 60: [-118, 33] }));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(sources.route.setData).toHaveBeenLastCalledWith(expect.objectContaining({
    geometry: { type: 'LineString', coordinates: [[-118, 33], [-118, 33]] },
  }));
  const loaded = app.store.getState().currentRoute;
  sources.route.setData.mockClear();
  app.replaceRoute({ ...loaded, is_public: true });
  expect(app.store.getState().currentRoute.driveCoords).toBe(loaded.driveCoords);
  expect(sources.route.setData).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(2);
  app.replaceRoute(null);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(sources.route.setData).toHaveBeenLastCalledWith(expect.objectContaining({
    geometry: { type: 'LineString', coordinates: [] },
  }));
});

test('a newer route version requests coordinates while the previous version is still pending', async () => {
  let resolveOld;
  fetch.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
  const app = renderMap(route);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  app.replaceRoute({ ...route, maxqlog: 1 });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(app.store.getState().currentRoute.driveCoords).toEqual({ 0: [-118, 33], 60: [-118, 33] }));
  const loaded = app.store.getState().currentRoute.driveCoords;
  await act(async () => resolveOld({ ok: true, json: async () => [{ t: 0, lng: -119, lat: 34 }] }));
  expect(app.store.getState().currentRoute.driveCoords).toBe(loaded);
});
