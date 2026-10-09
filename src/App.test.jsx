import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryHistory } from 'history';

import App from './App';
import { createInitialState } from './initialState';
import { createAppStore } from './store';

const mocks = vi.hoisted(() => ({ authenticated: true, options: {}, requests: [], hardNavigate: vi.fn() }));

vi.mock('@commaai/my-comma-auth', () => ({
  default: {
    init: vi.fn(async () => mocks.authenticated ? 'test-token' : null),
    isAuthenticated: vi.fn(() => mocks.authenticated),
    logOut: vi.fn(),
  },
  config: { AUTH_PATH: '/auth/' },
  storage: { setCommaAccessToken: vi.fn() },
}));
vi.mock('./utils/navigation', () => ({ hardNavigate: mocks.hardNavigate }));
vi.mock('./utils/turn', () => ({ fetchTurnCredentials: vi.fn(async () => null) }));
vi.mock('./utils/webrtc', () => ({
  webrtcConnectionManager: {
    acquire: vi.fn(() => ({ setQuality: vi.fn(), switchCamera: vi.fn() })),
    connection: null,
    disconnect: vi.fn(),
    prewarm: vi.fn(),
    reconnect: vi.fn(),
    release: vi.fn(),
  },
}));
vi.mock('react-map-gl', () => ({
  default: React.forwardRef((_props, ref) => <div ref={ref} data-testid="map" />),
  GeolocateControl: () => null,
  HTMLOverlay: () => null,
  Layer: () => null,
  LinearInterpolator: class {},
  Marker: ({ children }) => children,
  Source: ({ children }) => children,
  WebMercatorViewport: class {},
}));
vi.mock('react-player/file', () => ({
  default: React.forwardRef((_props, ref) => {
    React.useImperativeHandle(ref, () => ({
      getCurrentTime: () => 0,
      getDuration: () => 60,
      getInternalPlayer: () => ({
        buffered: { end: () => 60, length: 1, start: () => 0 },
        pause: vi.fn(), paused: true, play: vi.fn(async () => undefined), playbackRate: 1, readyState: 4,
      }),
      seekTo: vi.fn(),
    }));
    return <div data-testid="video-player" />;
  }),
}));
vi.mock('barcode-detector/ponyfill', () => ({ BarcodeDetector: class { detect() { return []; } } }));

const FIRST = 'aaaaaaaaaaaaaaaa';
const SECOND = 'bbbbbbbbbbbbbbbb';
const SHARED = 'cccccccccccccccc';
const LOG = '2026-08-06--12-00-00';
const RECENT_LOG = '2026-08-06--13-00-00';
const START = Date.UTC(2026, 7, 6, 12);

const devices = [
  { alias: 'Zulu', dongle_id: FIRST, device_type: 'threex', is_owner: true, prime: false },
  { alias: 'Alpha', dongle_id: SECOND, device_type: 'threex', is_owner: true, prime: false },
];

function makeRoute(dongleId, logId = RECENT_LOG) {
  const start = logId === LOG ? START : START + 3_600_000;
  return {
    create_time: start, distance: 1, dongle_id: dongleId, end_time_utc_millis: start + 60_000,
    events: [], fullname: `${dongleId}|${logId}`, maxqlog: 0,
    segment_end_times: [start + 60_000], segment_numbers: [0], segment_start_times: [start],
    startLocation: { place: logId === LOG ? 'Mock route start' : 'Mock recent route start', details: 'Start details' },
    endLocation: { place: 'Mock route end', details: 'End details' }, start_time_utc_millis: start,
    url: 'https://routes.example.com',
  };
}

function json(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

async function mockFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url);
  mocks.requests.push({ method: init.method || 'GET', url: url.href });
  const options = mocks.options;
  const deviceList = options.devices ?? devices;
  if (url.pathname === '/v1/me/turn') return json(null);
  if (url.pathname === '/v1/me/') return json({ id: 'test-user', superuser: false });
  if (url.pathname === '/v1/me/devices/') return json(deviceList);
  if (url.pathname === '/v1/referrals') return json(options.referrals ?? {
    code: 'ABC1234',
    cash: { available: 50, claimed: 50, pending: 50 },
    referrals: [
      { ordered_at: 1_777_000_000, status: 'available' },
      { ordered_at: 1_778_000_000, status: 'pending' },
      { ordered_at: 1_779_000_000, status: 'claimed' },
    ],
  });
  const segments = url.pathname.match(/^\/v1\/devices\/([a-f0-9]{16})\/routes_segments$/);
  if (segments) {
    const dongleId = segments[1];
    if (options.failedRoutes && url.searchParams.has('start')) return json({}, 500);
    if (options.emptyRoutes) return json([]);
    const routeStr = url.searchParams.get('route_str');
    if (routeStr) return json([LOG, RECENT_LOG].some((log) => routeStr.endsWith(`|${log}`)) ? [makeRoute(dongleId, routeStr.split('|')[1])] : []);
    if (window.location.pathname.includes(`/${START}/`) || url.searchParams.get('start') === String(START)) return json([makeRoute(dongleId, LOG)]);
    return json([makeRoute(dongleId)]);
  }
  if (url.pathname.endsWith('/location')) return json({ error: 'no_segments_uploaded' });
  if (url.pathname.endsWith('/stats')) return json(null);
  if (/^\/v1\.1\/devices\/[a-f0-9]{16}\/$/.test(url.pathname)) {
    const dongleId = url.pathname.split('/')[3];
    return json({ alias: 'Shared device', dongle_id: dongleId, device_type: 'threex', is_owner: false, prime: false });
  }
  if (url.pathname.endsWith('/subscription')) return json(options.subscription || null);
  if (url.pathname === '/v1/prime/cancel') return json({ success: true });
  if (url.pathname.endsWith('/subscribe_info')) return json(null);
  if (url.pathname.endsWith('/events.json') || url.pathname.endsWith('/coords.json')) return json([]);
  if (url.pathname.endsWith('/files') || url.pathname.endsWith('/preserved')) return json(url.pathname.endsWith('/files') ? {} : []);
  if (url.hostname === 'athena.comma.ai') {
    const { method } = JSON.parse(init.body);
    return json({ jsonrpc: '2.0', id: 0, result: method === 'listUploadQueue' ? [] : {} });
  }
  throw new Error(`Unhandled request: ${init.method || 'GET'} ${url.href}`);
}

async function renderApp(pathname, options = {}) {
  mocks.authenticated = options.authenticated !== false;
  mocks.options = options;
  mocks.requests = [];
  window.history.replaceState({}, '', pathname);
  if (options.selected) localStorage.setItem('selectedDongleId', options.selected);
  const history = createMemoryHistory({ initialEntries: [pathname] });
  const store = createAppStore(history, createInitialState(history.location));
  const view = render(<App history={history} store={store} />);
  await waitFor(
    () => expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument(),
    { timeout: 5000 },
  );
  // Explorer initialization starts several independent async updates (device
  // details, stats, routes, and clip support). Let their promise chains finish
  // while React is inside act before handing control back to each test.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { ...view, history, store };
}

describe('whole-app behavior', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', vi.fn(mockFetch));
    vi.stubGlobal('PointerEvent', MouseEvent);
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} });
    Object.defineProperty(window, 'scrollTo', { value: vi.fn(), configurable: true });
    Object.defineProperty(window, 'visualViewport', { value: { height: 800 }, configurable: true });
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: vi.fn(() => null) });
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ bottom: 100, height: 100, left: 0, right: 1000, top: 0, width: 1000, x: 0, y: 0 }),
    });
  });
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mocks.hardNavigate.mockClear();
  });

  test('root uses a valid stored device and keeps the selection', async () => {
    const app = await renderApp('/', { selected: FIRST });
    expect(await screen.findByText('Mock recent route start')).toBeVisible();
    expect(app.history.location.pathname).toBe(`/${FIRST}`);
    expect(localStorage.getItem('selectedDongleId')).toBe(FIRST);
  });

  test('fetches the initial routes with a nonzero limit', async () => {
    await renderApp('/', { selected: FIRST });
    expect(await screen.findByText('Mock recent route start')).toBeVisible();
    const request = mocks.requests.find(({ url }) => url.includes('routes_segments'));
    expect(new URL(request.url).searchParams.get('limit')).toBe('5');
  });

  test.each([['no stored device', undefined], ['an unknown stored device', 'dddddddddddddddd']])('root selects first device with %s', async (_name, selected) => {
    const { history } = await renderApp('/', { selected });
    expect(await screen.findByText('Mock recent route start')).toBeVisible();
    expect(history.location.pathname).toBe(`/${FIRST}`);
    expect(localStorage.getItem('selectedDongleId')).toBe(FIRST);
  });

  test('root with no devices shows pairing', async () => {
    const { history } = await renderApp('/', { devices: [] });
    expect(await screen.findByRole('heading', { name: 'Pair your device' })).toBeVisible();
    expect(history.location.pathname).toBe('/');
  });

  test('an unknown URL shows not found even when the account has no devices', async () => {
    const { history } = await renderApp('/unknown', { devices: [] });
    expect(await screen.findByText('Page not found.')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Pair your device' })).not.toBeInTheDocument();
    expect(history.location.pathname).toBe('/unknown');
  });

  test('sharing a drive retains its range and unrelated query without dialog or pairing data', async () => {
    const share = vi.fn(async () => undefined);
    const previousShare = Object.getOwnPropertyDescriptor(navigator, 'share');
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    try {
      const pathname = `/${FIRST}/${LOG}/0/20`;
      await renderApp(`${pathname}?x=a%26b&dialog=route-info&device=${SECOND}&parent=settings&clip=example.mp4&pair=token#video`);
      fireEvent.click(await screen.findByText('Share this route'));
      expect(share).toHaveBeenCalledExactlyOnceWith({
        title: 'comma connect', url: `${window.location.origin}${pathname}?x=a%26b#video`,
      });
    } finally {
      if (previousShare) Object.defineProperty(navigator, 'share', previousShare);
      else delete navigator.share;
    }
  });

  test('referrals URL opens the referrals page', async () => {
    await renderApp('/referrals');
    expect(await screen.findByRole('heading', { name: /Refer a friend/ })).toBeVisible();
    expect((await screen.findAllByText('$50', { selector: 'dd' }))).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'claim rewards ($50)' })).toHaveAttribute(
      'href', expect.stringContaining('Referral%20coupon%3A%20ABC1234'),
    );
    expect(mocks.requests).toContainEqual({ method: 'GET', url: 'https://billing.comma.ai/v1/referrals' });
  });

  test.each([['owned', FIRST], ['shared', SHARED]])('direct entry opens %s device dashboard', async (_name, dongleId) => {
    const { history } = await renderApp(`/${dongleId}`);
    expect(await screen.findByText('Mock recent route start')).toBeVisible();
    expect(history.location.pathname).toBe(`/${dongleId}`);
  });

  test('dashboard filter and empty route states remain usable', async () => {
    await renderApp(`/${FIRST}`, { emptyRoutes: true });
    expect(await screen.findByText('No routes found in selected time range.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.requests.some(({ url }) => url.includes('routes_segments'))).toBe(true);
  });

  test.each([
    ['authenticated whole drive', `/${FIRST}/${LOG}`, true],
    ['authenticated ranged drive', `/${FIRST}/${LOG}/10/20`, true],
    ['public whole drive', `/${FIRST}/${LOG}`, false],
    ['public ranged drive', `/${FIRST}/${LOG}/10/20`, false],
  ])('%s opens from a cold entry', async (_name, pathname, authenticated) => {
    const { history, store } = await renderApp(pathname, { authenticated });
    expect(await screen.findByRole('slider', { name: 'Drive timeline' })).toBeVisible();
    expect(history.location.pathname).toBe(pathname);
    const ranged = pathname.endsWith('/10/20');
    expect(store.getState()).toMatchObject({
      selectedRouteId: LOG,
      zoom: { start: ranged ? 10000 : 0, end: ranged ? 20000 : 60000 },
      loop: { startTime: ranged ? 10000 : 0, duration: ranged ? 10000 : 60000 },
    });
  });

  test.each([
    ['private device', `/${FIRST}`], ['Prime', `/${FIRST}/prime`], ['stream', `/${FIRST}/stream`],
  ])('signed-out %s entry retains its path', async (_name, pathname) => {
    const { history } = await renderApp(pathname, { authenticated: false });
    expect(await screen.findByText('Sign in with Google')).toBeVisible();
    expect(history.location.pathname).toBe(pathname);
  });

  test('a missing public route redirects to login with the requested route', async () => {
    const pathname = `/${FIRST}/2026-08-06--99-99-99`;
    await renderApp(pathname, { authenticated: false });
    await waitFor(() => expect(mocks.hardNavigate).toHaveBeenCalledWith(`/?r=${encodeURIComponent(pathname)}`));
  });

  test('legacy timestamp URL converts after a successful lookup', async () => {
    const { history } = await renderApp(`/${FIRST}/${START}/${START + 60_000}`);
    expect(await screen.findByRole('slider', { name: 'Drive timeline' })).toBeVisible();
    await waitFor(() => expect(history.location.pathname).toBe(`/${FIRST}/${LOG}`));
  });

  test.each([['empty', { emptyRoutes: true }], ['failed', { failedRoutes: true }]])('legacy timestamp remains after an %s lookup', async (_name, options) => {
    const pathname = `/${FIRST}/${START}/${START + 60_000}`;
    const { history } = await renderApp(pathname, options);
    await waitFor(() => expect(history.location.pathname).toBe(pathname));
  });

  test('Prime close and browser history restore its view', async () => {
    const { history } = await renderApp(`/${FIRST}/prime`);
    expect(await screen.findByRole('heading', { name: 'comma prime' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Go Back' }));
    await waitFor(() => expect(history.location.pathname).toBe(`/${FIRST}`));
    act(() => history.goBack());
    expect(await screen.findByRole('heading', { name: 'comma prime' })).toBeVisible();
  });

  test('stream close and browser history restore its view', async () => {
    const online = devices.map((device) => ({ ...device, commacare: true, last_athena_ping: Math.floor(Date.now() / 1000), openpilot_version: '0.11.2' }));
    const { history } = await renderApp(`/${FIRST}/stream`, { devices: online });
    expect(await screen.findByRole('button', { name: 'Close teleop' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close teleop' }));
    await waitFor(() => expect(history.location.pathname).toBe(`/${FIRST}`));
    act(() => history.goBack());
    expect(await screen.findByRole('button', { name: 'Close teleop' })).toBeVisible();
  });

  test('device browser history restores exact dashboards', async () => {
    const { history } = await renderApp(`/${FIRST}`);
    expect(await screen.findByText('Mock recent route start')).toBeVisible();
    act(() => history.push(`/${SECOND}`));
    await waitFor(() => expect(history.location.pathname).toBe(`/${SECOND}`));
    act(() => history.goBack());
    await waitFor(() => expect(history.location.pathname).toBe(`/${FIRST}`));
    act(() => history.goForward());
    await waitFor(() => expect(history.location.pathname).toBe(`/${SECOND}`));
  });

  test('drive selection, timeline range, back, and close preserve exact URLs', async () => {
    const { history } = await renderApp(`/${FIRST}`, { selected: FIRST });
    fireEvent.click(await screen.findByText('Mock recent route start'));
    await waitFor(() => expect(history.location.pathname).toBe(`/${FIRST}/${RECENT_LOG}`));
    const timeline = await screen.findByRole('slider', { name: 'Drive timeline' });
    fireEvent.pointerDown(timeline, { button: 0, clientX: 200, pageX: 200 });
    fireEvent.pointerMove(document, { clientX: 700, pageX: 700 });
    fireEvent.pointerUp(document, { button: 0, clientX: 700, pageX: 700 });
    await waitFor(() => expect(history.location.pathname).toMatch(new RegExp(`/${FIRST}/${RECENT_LOG}/[0-9.]+/[0-9.]+$`)));
    act(() => history.goBack());
    await waitFor(() => expect(history.location.pathname).toBe(`/${FIRST}/${RECENT_LOG}`));
    fireEvent.click(within(document.body).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(history.location.pathname).toBe(`/${FIRST}`));
  });
  test.each([
    [`/${FIRST}?dialog=settings`, 'Device name'],
    [`/${FIRST}/${LOG}?dialog=settings&device=${SECOND}`, 'Device name'],
  ])('device settings opens from a cold URL %s', async (url, label) => {
    const { history, store } = await renderApp(url);
    expect(await screen.findByRole('dialog', { name: 'Device settings' })).toBeVisible();
    const input = await screen.findByLabelText(label);
    expect(input).toHaveValue(url.includes(`device=${SECOND}`) ? 'Alpha' : 'Zulu');
    expect(store.getState().dongleId).toBe(FIRST);
    expect(history.location.search).toBe(new URL(url, 'https://connect.comma.ai').search);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(history.location.search).toBe(''));
    act(() => history.goBack());
    expect(await screen.findByLabelText(label)).toBeVisible();
  });

  test('settings, Back and Forward retain drive playback and loaded route data', async () => {
    const { history, store } = await renderApp(`/${FIRST}/${LOG}/0/20`);
    expect(await screen.findByRole('slider', { name: 'Drive timeline' })).toBeVisible();
    act(() => store.dispatch({ type: 'ACTION_SEEK', offset: 12345 }));
    const before = store.getState();
    const routeRequests = mocks.requests.filter(({ url }) => url.includes('routes_segments')).length;
    act(() => history.push(`/${FIRST}/${LOG}/0/20?dialog=settings&device=${SECOND}`));
    expect(await screen.findByLabelText('Device name')).toHaveValue('Alpha');
    expect(store.getState().zoom).toBe(before.zoom);
    expect(store.getState().currentRoute).toBe(before.currentRoute);
    expect(store.getState().offset).toBe(before.offset);
    act(() => history.goBack());
    await waitFor(() => expect(screen.queryByLabelText('Device name')).not.toBeInTheDocument());
    act(() => history.goForward());
    expect(await screen.findByLabelText('Device name')).toBeVisible();
    expect(mocks.requests.filter(({ url }) => url.includes('routes_segments'))).toHaveLength(routeRequests);
  });

  test.each([
    [`/${FIRST}?dialog=filter`, 'Start date:'],
    [`/${FIRST}?dialog=uploads`, 'Upload queue'],
    [`/${FIRST}?dialog=clips`, 'CLIPS ON THIS DEVICE'],
    [`/${FIRST}/${LOG}?dialog=clips`, 'Create a clip'],
    ['/?dialog=pair', 'Pair device'],
  ])('opens a major dialog from %s', async (url, text) => {
    const { history } = await renderApp(url);
    expect(await screen.findByText(text)).toBeVisible();
    expect(history.location.search).toBe(new URL(url, 'https://connect.comma.ai').search);
  });

  test('filter drafts survive same-device navigation but reset to the next device’s saved filter', async () => {
    const { history, store } = await renderApp(`/${SECOND}?dialog=filter`);
    const dates = () => [screen.getByLabelText('Start date:'), screen.getByLabelText('End date:')];
    const changeDates = (start, end) => {
      fireEvent.change(dates()[0], { target: { value: start } });
      fireEvent.change(dates()[1], { target: { value: end } });
    };
    expect(await screen.findByRole('dialog', { name: 'Filter' })).toBeVisible();
    changeDates('2026-08-01', '2026-08-02');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(history.location.search).toBe(''));
    const secondFilter = store.getState().filter;

    act(() => history.push(`/${FIRST}?dialog=filter`));
    expect(await screen.findByText('Start date:')).toBeVisible();
    const firstFilter = store.getState().filter;
    changeDates('2026-08-03', '2026-08-04');
    act(() => history.push(`/${FIRST}?dialog=filter&x=1`));
    expect(dates()[0]).toHaveValue('2026-08-03');
    expect(dates()[1]).toHaveValue('2026-08-04');

    act(() => history.push(`/${SECOND}?dialog=filter&x=1`));
    expect(dates()[0]).toHaveValue('2026-08-01');
    expect(dates()[1]).toHaveValue('2026-08-02');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(history.location.search).toBe('?x=1'));
    expect(store.getState().filter).toEqual(secondFilter);
    expect(store.getState().deviceCache[FIRST].filter).toEqual(firstFilter);
  });

  test('settings for an unselected device opens that same device upload queue', async () => {
    const { history, store } = await renderApp(`/referrals?dialog=settings&device=${SECOND}`);
    expect(await screen.findByLabelText('Device name')).toHaveValue('Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Uploads' }));
    expect(await screen.findByText('Upload queue')).toBeVisible();
    expect(history.location.pathname).toBe('/referrals');
    expect(history.location.search).toBe(`?dialog=uploads&device=${SECOND}&parent=settings`);
    expect(store.getState().navigation.dialogDevice).toBe(SECOND);
    expect(store.getState().dongleId).toBe(FIRST);
  });

  test('settings retains an unsaved alias through uploads, Close, Back and Forward', async () => {
    const { history } = await renderApp(`/${FIRST}/${LOG}/0/20?dialog=settings&device=${SECOND}`);
    fireEvent.change(await screen.findByLabelText('Device name'), { target: { value: 'Unsaved device name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Uploads' }));
    expect(await screen.findByText('Upload queue')).toBeVisible();
    expect(screen.queryByLabelText('Device name')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByLabelText('Device name')).toHaveValue('Unsaved device name');
    act(() => history.goBack());
    expect(await screen.findByText('Upload queue')).toBeVisible();
    act(() => history.goBack());
    expect(await screen.findByLabelText('Device name')).toHaveValue('Unsaved device name');
    act(() => history.goForward());
    expect(await screen.findByText('Upload queue')).toBeVisible();
    act(() => history.goForward());
    expect(await screen.findByLabelText('Device name')).toHaveValue('Unsaved device name');
    expect(history.location.pathname).toBe(`/${FIRST}/${LOG}/0/20`);
  });

  test('a cold nested upload queue closes to its target device settings', async () => {
    const { history, store } = await renderApp(`/${FIRST}/${LOG}/0/20?dialog=uploads&device=${SECOND}&parent=settings`);
    expect(await screen.findByRole('dialog', { name: 'Upload queue' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByLabelText('Device name')).toHaveValue('Alpha');
    expect(history.location.pathname).toBe(`/${FIRST}/${LOG}/0/20`);
    expect(history.location.search).toBe(`?dialog=settings&device=${SECOND}`);
    expect(store.getState().dongleId).toBe(FIRST);
  });

  test('a cold unpair URL opens the target confirmation without unpairing', async () => {
    const { history, store } = await renderApp(`/${FIRST}/${LOG}?dialog=unpair&device=${SECOND}`);
    expect(await screen.findByRole('dialog', { name: 'Unpair device' })).toBeVisible();
    const title = await screen.findByRole('heading', { name: 'Unpair device' });
    expect(title).toBeVisible();
    expect(within(title.parentElement).getByText(SECOND)).toBeVisible();
    expect(mocks.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByLabelText('Device name')).toHaveValue('Alpha');
    expect(history.location.search).toBe(`?dialog=settings&device=${SECOND}`);
    expect(store.getState().dongleId).toBe(FIRST);
  });

  test('unpair Cancel, Escape and browser history preserve the settings draft', async () => {
    const { history } = await renderApp(`/${FIRST}?dialog=settings`);
    fireEvent.change(await screen.findByLabelText('Device name'), { target: { value: 'Unsaved device name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unpair' }));
    expect(await screen.findByRole('heading', { name: 'Unpair device' })).toBeVisible();
    expect(history.location.search).toBe(`?dialog=unpair&device=${FIRST}`);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByLabelText('Device name')).toHaveValue('Unsaved device name');
    act(() => history.goBack());
    expect(await screen.findByRole('heading', { name: 'Unpair device' })).toBeVisible();
    act(() => history.goBack());
    expect(await screen.findByLabelText('Device name')).toHaveValue('Unsaved device name');
    act(() => history.goForward());
    expect(await screen.findByRole('heading', { name: 'Unpair device' })).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape', keyCode: 27 });
    expect(await screen.findByLabelText('Device name')).toHaveValue('Unsaved device name');
    expect(mocks.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
  });

  test('nested uploads applies the settings access guard to a shared target device', async () => {
    await renderApp(`/${FIRST}?dialog=uploads&device=${SECOND}&parent=settings`, {
      devices: devices.map((device) => ({ ...device, is_owner: device.dongle_id === FIRST })),
    });
    expect(await screen.findByText('No access to this device.')).toBeVisible();
    expect(screen.queryByLabelText('Device name')).not.toBeInTheDocument();
    expect(screen.queryByText('Upload queue')).not.toBeInTheDocument();
  });

  test('opening pairing mounts exactly one scanner even when both entry buttons are present', async () => {
    const { history } = await renderApp(`/${FIRST}`);
    act(() => history.push(`/${FIRST}?dialog=pair`));
    expect(await screen.findAllByText('Pair device')).toHaveLength(1);
    act(() => history.goBack());
    await waitFor(() => expect(screen.queryByText('Pair device')).not.toBeInTheDocument());
    act(() => history.goForward());
    expect(await screen.findAllByText('Pair device')).toHaveLength(1);
  });

  test.each([
    ['cancel-prime', 'Cancel prime subscription'],
    ['change-plan', 'Switch to Standard plan'],
  ])('opens the %s confirmation without submitting a transaction', async (dialog, title) => {
    const { history } = await renderApp(`/${FIRST}/prime?dialog=${dialog}`, {
      devices: devices.map((device) => ({ ...device, prime: true })),
      subscription: { user_id: 'test-user', plan: 'nodata', subscribed_at: 1000, next_charge_at: 2000 },
    });
    expect(await screen.findByRole('heading', { name: title })).toBeVisible();
    expect(history.location.search).toBe(`?dialog=${dialog}`);
    expect(mocks.requests.filter(({ method }) => method !== 'GET')).toEqual([]);
  });

  test('a completed cancellation remains disabled after reopening with stale subscription data', async () => {
    const { history, store } = await renderApp(`/${FIRST}/prime?dialog=cancel-prime`, {
      devices: devices.map((device) => ({ ...device, prime: true })),
      subscription: { user_id: 'test-user', plan: 'nodata', subscribed_at: 1000, next_charge_at: 2000 },
    });
    const heading = await screen.findByRole('heading', { name: 'Cancel prime subscription' });
    fireEvent.click(within(heading.parentElement).getByRole('button', { name: 'Cancel subscription' }));
    expect(await screen.findByText('Cancelled subscription.')).toBeVisible();
    await waitFor(() => expect(mocks.requests.filter(({ url }) => new URL(url).pathname.endsWith('/subscription'))).toHaveLength(2));
    expect(store.getState().subscription.cancel_at).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText('Cancelled subscription.')).not.toBeInTheDocument());
    act(() => history.goBack());
    expect(await screen.findByText('Cancelled subscription.')).toBeVisible();
    const cancel = screen.getByRole('button', { name: 'Cancel subscription' });
    expect(cancel).toBeDisabled();
    fireEvent.click(cancel);
    expect(mocks.requests.filter(({ method, url }) => method === 'POST' && new URL(url).pathname === '/v1/prime/cancel')).toHaveLength(1);
  });

  test('anonymous navigation follows the public/private boundary and retains the complete login destination', async () => {
    const { history } = await renderApp(`/${FIRST}/${LOG}`, { authenticated: false });
    expect(await screen.findByRole('slider', { name: 'Drive timeline' })).toBeVisible();
    const destination = `/${FIRST}/${LOG}?dialog=settings#video`;
    act(() => history.push(destination));
    expect(await screen.findByText('Sign in with Google')).toBeVisible();
    expect(sessionStorage.getItem('redirectURL')).toBe(destination);
    act(() => history.goBack());
    expect(await screen.findByRole('slider', { name: 'Drive timeline' })).toBeVisible();
  });

  test('warm same-device navigation loads an older drive without replacing the dashboard list', async () => {
    const { history, store } = await renderApp(`/${FIRST}`);
    expect(await screen.findByText('Mock recent route start')).toBeVisible();
    const list = store.getState().routes;
    act(() => history.push(`/${FIRST}/${LOG}`));
    expect(await screen.findByRole('slider', { name: 'Drive timeline' })).toBeVisible();
    expect(store.getState().currentRoute.log_id).toBe(LOG);
    expect(store.getState().routes).toBe(list);
    act(() => history.goBack());
    expect(await screen.findByText('Mock recent route start')).toBeVisible();
    expect(store.getState().selectedRouteId).toBeNull();
  });

  test('settings opened in a temporary drawer remains visible after the drawer closes', async () => {
    const { history } = await renderApp(`/${FIRST}`);
    fireEvent.click(screen.getByRole('button', { name: 'menu' }));
    const deviceLink = await screen.findByRole('link', { name: /Zulu/ });
    fireEvent.click(within(deviceLink).getByRole('button', { name: 'device settings' }));
    expect(await screen.findByLabelText('Device name')).toHaveValue('Zulu');
    expect(history.location.search).toBe(`?dialog=settings&device=${FIRST}`);
    await waitFor(() => expect(screen.queryByRole('link', { name: /Zulu/ })).not.toBeInTheDocument());
    expect(screen.getByLabelText('Device name')).toBeVisible();
  });

  test.each(['downloads', 'route-info'])('a public drive can open its %s dialog without signing in', async (dialog) => {
    const { history } = await renderApp(`/${FIRST}/${LOG}?dialog=${dialog}`, { authenticated: false });
    expect(await screen.findByRole('menu')).toBeVisible();
    expect(screen.queryByText('Sign in with Google')).not.toBeInTheDocument();
    expect(history.location.search).toBe(`?dialog=${dialog}`);
  });

  test('More info fetches the current drive files when files from another drive are retained', async () => {
    const { history, store } = await renderApp(`/${FIRST}/${LOG}`);
    expect(await screen.findByRole('slider', { name: 'Drive timeline' })).toBeVisible();
    act(() => store.dispatch({ type: 'ACTION_FILES_URLS', dongleId: FIRST,
      urls: { [`${FIRST}|${LOG}--0/qcameras`]: { url: 'https://routes.example.com/a.ts' } } }));
    act(() => history.push(`/${FIRST}/${RECENT_LOG}`));
    await waitFor(() => expect(store.getState().currentRoute?.log_id).toBe(RECENT_LOG));
    act(() => history.push(`/${FIRST}/${RECENT_LOG}?dialog=route-info`));
    expect(await screen.findByRole('menu')).toBeVisible();
    await waitFor(() => expect(mocks.requests.some(({ url }) => (
      decodeURIComponent(url).includes(`${FIRST}|${RECENT_LOG}/files`)
    ))).toBe(true));
  });

  test('leaving pairing stops a camera stream acquired after the dialog closed', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    let resolveStream;
    const stop = vi.fn();
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [{ kind: 'videoinput' }]),
      getUserMedia: vi.fn(() => new Promise((resolve) => { resolveStream = resolve; })),
    };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
    try {
      const { history } = await renderApp(`/${FIRST}`);
      act(() => history.push(`/${FIRST}?dialog=pair`));
      await waitFor(() => expect(mediaDevices.getUserMedia).toHaveBeenCalledOnce());
      act(() => history.goBack());
      await act(async () => resolveStream({ getTracks: () => [{ stop }] }));
      expect(stop).toHaveBeenCalledOnce();
      expect(screen.queryByText('Pair device')).not.toBeInTheDocument();
    } finally {
      if (original) Object.defineProperty(navigator, 'mediaDevices', original);
      else delete navigator.mediaDevices;
    }
  });

});
