import React from 'react';
import { Provider, connect } from 'react-redux';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryHistory } from 'history';
import { LOCATION_CHANGE } from 'connected-react-router';

import { api } from '../api/backend';
import { createInitialState } from '../initialState';
import { createAppStore } from '../store';
import { routeLoadKey } from '../routeLoadStatus';
import { hardNavigate } from '../utils/navigation';
import DriveView from '../components/DriveView';

vi.mock('../api/backend', () => ({ api: {
  auth: { isAuthenticated: vi.fn(() => true) },
  routes: { getRoutesSegments: vi.fn() },
} }));
vi.mock('./index', () => ({
  primeFetchSubscription: () => ({ type: 'SUBSCRIPTION_REQUEST' }),
  fetchDeviceOnline: () => ({ type: 'DEVICE_REQUEST' }),
  fetchSharedDevice: () => ({ type: 'SHARED_DEVICE_REQUEST' }),
}));
vi.mock('../analytics', () => ({ analyticsMiddleware: () => next => action => next(action) }));
vi.mock('../utils/webrtc', () => ({ webrtcConnectionManager: { disconnect: vi.fn() } }));
vi.mock('../utils/navigation', () => ({ hardNavigate: vi.fn() }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));
vi.mock('../components/DriveView/Media', () => ({ default: () => <div data-testid="drive-media" /> }));
vi.mock('../components/Timeline', () => ({ default: () => null }));

const DEVICE = 'aaaaaaaaaaaaaaaa';
const LOG = '2026-08-06--12-00-00';
const DRIVE = `/${DEVICE}/${LOG}`;
const LEGACY = `/${DEVICE}/1100/1500`;
const route = {
  fullname: `${DEVICE}|${LOG}`, create_time: 1000, distance: 1,
  start_time_utc_millis: 1000, end_time_utc_millis: 61000,
  segment_start_times: [1000], segment_end_times: [61000], segment_numbers: [0],
  url: 'https://routes.example.com',
};

const Page = connect(state => ({ page: state.navigation.page }))(({ page }) => (
  page === 'drive' ? <DriveView /> : <div>Dashboard</div>
));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function create(url, extra = {}) {
  const history = createMemoryHistory({ initialEntries: [url] });
  const store = createAppStore(history, {
    ...createInitialState(history.location),
    profile: { id: 'test-user' },
    devices: [{ dongle_id: DEVICE, is_owner: true }],
    device: { dongle_id: DEVICE, is_owner: true },
    limit: 5,
    ...extra,
  });
  history.listen((location, action) => store.dispatch({ type: LOCATION_CHANGE, payload: { location, action } }));
  const view = render(<Provider store={store}><Page /></Provider>);
  act(() => store.dispatch({ type: LOCATION_CHANGE, payload: { location: history.location, action: 'POP' } }));
  return { ...view, history, store };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.auth.isAuthenticated.mockReturnValue(true);
  api.routes.getRoutesSegments.mockReset().mockResolvedValue([route]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

test.each([['legacy', LEGACY], ['canonical', DRIVE]])('%s missing drives preserve their URL and wait for an explicit retry', async (_name, pathname) => {
  api.routes.getRoutesSegments.mockResolvedValue([]);
  const { history } = create(`${pathname}?x=1#video`);
  expect(await screen.findByText('Route does not exist.')).toBeVisible();
  expect(history.location).toMatchObject({ pathname, search: '?x=1', hash: '#video' });
  act(() => history.push(`${pathname}?x=1&dialog=settings#video`));
  act(() => history.goBack());
  expect(api.routes.getRoutesSegments).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Route does not exist.')).toBeVisible();
  expect(api.routes.getRoutesSegments).toHaveBeenCalledTimes(2);
  expect(hardNavigate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Back to drives' }));
  expect(history.location.pathname).toBe(`/${DEVICE}`);
  expect(screen.getByText('Dashboard')).toBeVisible();
});

test.each([
  ['legacy authenticated', LEGACY, true], ['legacy public', LEGACY, false],
  ['canonical authenticated', DRIVE, true], ['canonical public', DRIVE, false],
])('%s API errors show a recoverable failure and retry the unchanged selection', async (_name, pathname, authenticated) => {
  api.auth.isAuthenticated.mockReturnValue(authenticated);
  api.routes.getRoutesSegments.mockRejectedValueOnce(new Error('Network unavailable'));
  const { history } = create(`${pathname}?x=a%26b#video`);
  expect(await screen.findByText('Could not load this drive. Please try again.')).toBeVisible();
  expect(screen.queryByText('Route does not exist.')).not.toBeInTheDocument();
  expect(history.location).toMatchObject({ pathname, search: '?x=a%26b', hash: '#video' });
  expect(hardNavigate).not.toHaveBeenCalled();

  const retry = deferred();
  api.routes.getRoutesSegments.mockReturnValueOnce(retry.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(screen.getByText('Loading...')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  await act(async () => retry.resolve([route]));
  expect(await screen.findByTestId('drive-media')).toBeVisible();
  expect(history.location).toMatchObject({ search: '?x=a%26b', hash: '#video' });
  expect(history.location.pathname).toBe(pathname === LEGACY ? `${DRIVE}/0.1/0.5` : DRIVE);
});

test('an anonymous missing legacy lookup redirects with the latest full public URL', async () => {
  const lookup = deferred();
  api.auth.isAuthenticated.mockReturnValue(false);
  api.routes.getRoutesSegments.mockReturnValueOnce(lookup.promise);
  const { history } = create(`${LEGACY}?x=1#video`);
  const destination = `${LEGACY}?x=1&dialog=downloads#new-fragment`;
  act(() => history.push(destination));
  expect(api.routes.getRoutesSegments).toHaveBeenCalledOnce();
  await act(async () => lookup.resolve([]));
  expect(hardNavigate).toHaveBeenCalledExactlyOnceWith(`/?r=${encodeURIComponent(destination)}`);
});

test('an anonymous legacy lookup does not redirect a newer private dialog to another login URL', async () => {
  const lookup = deferred();
  api.auth.isAuthenticated.mockReturnValue(false);
  api.routes.getRoutesSegments.mockResolvedValue([]).mockReturnValueOnce(lookup.promise);
  const { history } = create(LEGACY);
  act(() => history.push(`${LEGACY}?dialog=settings`));
  await act(async () => lookup.resolve([]));
  expect(hardNavigate).not.toHaveBeenCalled();
  expect(history.location.search).toBe('?dialog=settings');
  await act(async () => history.goBack());
  expect(api.routes.getRoutesSegments).toHaveBeenCalledTimes(2);
  expect(hardNavigate).toHaveBeenCalledExactlyOnceWith(`/?r=${encodeURIComponent(LEGACY)}`);
});

test.each(['missing', 'error', 'success'])('a stale legacy %s response cannot redirect or change the current drive status', async (result) => {
  const lookup = deferred();
  api.auth.isAuthenticated.mockReturnValue(false);
  api.routes.getRoutesSegments.mockReturnValueOnce(lookup.promise);
  const cached = { ...route, log_id: LOG, duration: 60000 };
  const { history, store } = create(LEGACY, { routeCache: { [route.fullname]: cached } });
  act(() => history.push(DRIVE));
  await act(async () => {
    if (result === 'error') lookup.reject(new Error('Old request failed'));
    else lookup.resolve(result === 'success' ? [route] : []);
  });
  expect(history.location.pathname).toBe(DRIVE);
  expect(hardNavigate).not.toHaveBeenCalled();
  expect(store.getState().routeLoadStatus[routeLoadKey(store.getState().navigation)]).toBeUndefined();
  expect(screen.getByTestId('drive-media')).toBeVisible();
  expect(screen.queryByText('Could not load this drive. Please try again.')).not.toBeInTheDocument();
});

test('pending legacy lookups survive dialog changes and A to B to A navigation without duplicate requests', async () => {
  const first = deferred();
  const second = deferred();
  api.routes.getRoutesSegments.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { history } = create(LEGACY);
  act(() => history.push(`/${DEVICE}/2100/2500`));
  act(() => history.goBack());
  act(() => history.push(`${LEGACY}?dialog=settings&x=1#video`));
  expect(api.routes.getRoutesSegments).toHaveBeenCalledTimes(2);
  await act(async () => second.resolve([]));
  expect(screen.getByText('Loading...')).toBeVisible();
  await act(async () => first.resolve([route]));
  expect(await screen.findByTestId('drive-media')).toBeVisible();
  expect(history.location).toMatchObject({ pathname: `${DRIVE}/0.1/0.5`, search: '?dialog=settings&x=1', hash: '#video' });
});

test.each([
  ['malformed response', {}],
  ['invalid route identity', [{ ...route, fullname: `${DEVICE}|invalid` }]],
])('a legacy %s is an error rather than an endless loading state', async (_name, response) => {
  api.routes.getRoutesSegments.mockResolvedValue(response);
  create(LEGACY);
  expect(await screen.findByText('Could not load this drive. Please try again.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
});
