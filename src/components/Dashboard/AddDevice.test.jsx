import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { applyMiddleware, createStore } from 'redux';
import thunk from 'redux-thunk';
import { createMemoryHistory } from 'history';
import { replace, routerMiddleware } from 'connected-react-router';
import localforage from 'localforage';
import * as Sentry from '@sentry/react';

import App from '../../App';
import Explorer from '../explorer';
import { api } from '../../api/backend';
import { parseLocation } from '../../url';

const camera = vi.hoisted(() => ({
  detect: vi.fn(), enumerateDevices: vi.fn(), getUserMedia: vi.fn(), stop: vi.fn(),
}));
const startup = vi.hoisted(() => vi.fn());

vi.mock('barcode-detector/ponyfill', () => ({ BarcodeDetector: class {
  detect(video) { return camera.detect(video); }
} }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../../api/backend', () => ({
  api: { auth: { isAuthenticated: () => false }, devices: { pilotPair: vi.fn(), listDevices: vi.fn() } },
  initBackend: vi.fn(),
}));
vi.mock('../../api', () => ({ athena: {}, billing: {}, request: {} }));
vi.mock('@commaai/my-comma-auth', () => ({
  default: { init: vi.fn(async () => null) },
  config: { AUTH_PATH: '/auth/' },
  storage: {},
}));
vi.mock('../../store', () => ({ default: null, history: null }));
vi.mock('../../utils/webrtc', () => ({ webrtcConnectionManager: {} }));
vi.mock('../../utils/turn', () => ({ fetchTurnCredentials: vi.fn() }));
vi.mock('../../timeline', () => ({ currentOffset: () => 0 }));
vi.mock('../../actions/startup', () => ({ default: startup }));
vi.mock('../../actions', async () => ({
  ...await import('../../actions/navigation'),
  updateDevices: (devices) => ({ type: 'update-devices', devices }),
  analyticsEvent: (name, parameters) => ({ type: 'analytics', name, parameters }),
}));
vi.mock('../AppHeader', () => ({ default: () => null }));
vi.mock('../AppDrawer', () => ({ default: () => null }));
vi.mock('../IosPwaPopup', () => ({ default: () => null }));
vi.mock('../BodyTeleop', () => ({ default: () => null }));
vi.mock('../Referrals', () => ({ default: () => null }));
vi.mock('../DriveView', () => ({ default: () => null }));
vi.mock('../DriveView/NoDeviceUpsell', () => ({ default: () => null }));
vi.mock('../anonymous', () => ({ default: () => <div>Sign in</div> }));
vi.mock('../Dashboard', () => ({ default: () => <input aria-label="Dashboard draft" defaultValue="" /> }));
vi.mock('./DeviceSettingsModal', () => ({ default: () => null }));
vi.mock('../Files/UploadQueue', () => ({ default: () => null }));
vi.mock('../TimeSelect', () => ({ default: () => null }));

const EXISTING = 'aaaaaaaaaaaaaaaa';
const PAIRED = 'bbbbbbbbbbbbbbbb';
const NEXT = 'cccccccccccccccc';
const existingDevices = [{ dongle_id: EXISTING }];
const pairedDevices = [...existingDevices, { dongle_id: PAIRED }];
const token = (identity = PAIRED) => `header.${btoa(JSON.stringify({ identity }))}.signature`;
const tokenUrl = (value = token()) => `/${EXISTING}?pair=${encodeURIComponent(value)}`;
const subscriptions = [];
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function createHarness(url, devices = existingDevices) {
  const history = createMemoryHistory({ initialEntries: [url] });
  const actions = [];
  const draft = {};
  const initial = {
    router: { location: history.location, action: history.action }, navigation: parseLocation(history.location),
    dongleId: parseLocation(history.location).dongleId, devices, profile: { id: 'test-user' }, draft,
  };
  const reducer = (state = initial, action) => {
    if (action.type === 'location') {
      const navigation = parseLocation(action.location);
      return {
        ...state, router: { location: action.location, action: action.historyAction }, navigation, dongleId: navigation.dongleId,
      };
    }
    if (action.type === 'startup-data') return { ...state, dongleId: action.dongleId };
    if (action.type === 'update-devices') return { ...state, devices: action.devices };
    return state;
  };
  const record = () => next => action => { actions.push(action); return next(action); };
  const store = createStore(reducer, applyMiddleware(thunk, record, routerMiddleware(history)));
  subscriptions.push(history.listen((location, historyAction) => store.dispatch({ type: 'location', location, historyAction })));
  return { history, store, actions, draft };
}

function renderPairing(url = tokenUrl(), devices) {
  const app = createHarness(url, devices);
  return { ...app, ...render(<Provider store={app.store}><Explorer /></Provider>) };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.devices.pilotPair.mockReset().mockResolvedValue({ dongle_id: PAIRED });
  api.devices.listDevices.mockReset().mockResolvedValue(pairedDevices);
  localforage.getItem.mockReset().mockResolvedValue(null);
  localforage.setItem.mockReset().mockResolvedValue(undefined);
  localforage.removeItem.mockReset().mockResolvedValue(undefined);
  startup.mockReset().mockReturnValue({ type: 'startup' });
  camera.detect.mockReset().mockResolvedValue([]);
  camera.enumerateDevices.mockReset().mockResolvedValue([{ kind: 'videoinput' }]);
  camera.getUserMedia.mockReset().mockResolvedValue({ getTracks: () => [{ stop: camera.stop }] });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: camera });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  });
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  subscriptions.splice(0).forEach((unsubscribe) => unsubscribe());
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

afterAll(() => {
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
  else delete navigator.mediaDevices;
});

test.each(['legacy', 'explicit'])('%s token URL has one pairing dialog and closes by selecting the paired device', async (format) => {
  localforage.getItem.mockResolvedValue(token());
  const url = tokenUrl() + (format === 'explicit' ? '&dialog=pair' : '');
  const app = renderPairing(url);
  expect(document.querySelectorAll('#add-device-modal')).toHaveLength(1);
  expect(await screen.findByText(/Successfully paired device/)).toHaveTextContent(PAIRED);
  expect(api.devices.pilotPair).toHaveBeenCalledExactlyOnceWith(token());
  expect(camera.enumerateDevices).not.toHaveBeenCalled();
  expect(camera.getUserMedia).not.toHaveBeenCalled();
  expect(localforage.removeItem).toHaveBeenCalledExactlyOnceWith('pairToken');
  expect(app.store.getState().devices).toEqual(pairedDevices);
  expect(app.actions.filter(({ type }) => type === 'analytics')).toEqual([
    { type: 'analytics', name: 'pair_device', parameters: { method: 'url_string' } },
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(app.history.location.pathname).toBe(`/${PAIRED}`);
  expect(app.history.location.search).toBe('');
  expect(screen.queryByText('Pairing device')).not.toBeInTheDocument();
  expect(app.store.getState().draft).toBe(app.draft);
});

test.each(['missing', 'denied'])('a %s camera has an explicit Close action that preserves the underlying URL', async (failure) => {
  if (failure === 'missing') camera.enumerateDevices.mockResolvedValue([]);
  else camera.getUserMedia.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
  const app = renderPairing(`/${EXISTING}?x=1&dialog=pair#device`);
  const message = failure === 'missing'
    ? 'Camera not found, please enable camera access.'
    : 'Camera access denied. Please allow camera access in your browser settings and try again.';
  expect(await screen.findByText(message)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(app.history.location).toMatchObject({ pathname: `/${EXISTING}`, search: '?x=1', hash: '#device' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(api.devices.pilotPair).not.toHaveBeenCalled();
});

test('Back and Forward reuse a pending transaction and its completed result while preserving the page', async () => {
  const pairing = deferred();
  api.devices.pilotPair.mockReturnValueOnce(pairing.promise);
  const app = renderPairing(`/${EXISTING}`);
  fireEvent.change(screen.getByRole('textbox', { name: 'Dashboard draft' }), { target: { value: 'unsaved note' } });
  act(() => app.history.push(tokenUrl()));
  expect(screen.getByRole('progressbar', { name: 'Pairing device' })).toBeVisible();
  act(() => app.history.goBack());
  expect(screen.queryByText('Pairing device')).not.toBeInTheDocument();
  act(() => app.history.goForward());
  expect(api.devices.pilotPair).toHaveBeenCalledOnce();
  await act(async () => pairing.resolve({ dongle_id: PAIRED }));
  expect(await screen.findByText(/Successfully paired device/)).toBeVisible();
  act(() => app.history.goBack());
  act(() => app.history.goForward());
  expect(await screen.findByText(/Successfully paired device/)).toBeVisible();
  expect(api.devices.pilotPair).toHaveBeenCalledOnce();
  expect(api.devices.listDevices).toHaveBeenCalledOnce();
  expect(app.actions.filter(({ type }) => type === 'analytics')).toHaveLength(1);
  act(() => app.history.goBack());
  expect(screen.getByRole('textbox', { name: 'Dashboard draft' })).toHaveValue('unsaved note');
});

test('a new token gets its own transaction and ignores the previous token’s late result', async () => {
  const oldPairing = deferred();
  api.devices.pilotPair.mockReturnValueOnce(oldPairing.promise).mockResolvedValueOnce({ dongle_id: NEXT });
  const app = renderPairing();
  act(() => app.history.push(tokenUrl(token(NEXT))));
  expect(await screen.findByText(/Successfully paired device/)).toHaveTextContent(NEXT);
  await act(async () => oldPairing.resolve({ dongle_id: PAIRED }));
  expect(screen.getByText(/Successfully paired device/)).toHaveTextContent(NEXT);
  expect(api.devices.pilotPair.mock.calls).toEqual([[token()], [token(NEXT)]]);
});

test('an earlier device-list snapshot cannot remove a device from a newer successful pairing', async () => {
  const firstRefresh = deferred();
  const newestDevices = [...pairedDevices, { dongle_id: NEXT }];
  api.devices.pilotPair.mockResolvedValueOnce({ dongle_id: PAIRED }).mockResolvedValueOnce({ dongle_id: NEXT });
  api.devices.listDevices.mockReturnValueOnce(firstRefresh.promise).mockResolvedValueOnce(newestDevices);
  const app = renderPairing();
  await waitFor(() => expect(api.devices.listDevices).toHaveBeenCalledOnce());
  act(() => app.history.push(tokenUrl(token(NEXT))));
  expect(await screen.findByText(/Successfully paired device/)).toHaveTextContent(NEXT);
  expect(app.store.getState().devices).toEqual(newestDevices);
  await act(async () => firstRefresh.resolve(pairedDevices));
  expect(app.store.getState().devices).toEqual(newestDevices);
  expect(screen.getByText(/Successfully paired device/)).toHaveTextContent(NEXT);
});

test('switching from the camera to a literal camera token validates it and stops a late camera stream', async () => {
  const stream = deferred();
  camera.getUserMedia.mockReturnValueOnce(stream.promise);
  const app = renderPairing(`/${EXISTING}?dialog=pair`);
  await waitFor(() => expect(camera.getUserMedia).toHaveBeenCalledOnce());
  act(() => app.history.push(tokenUrl('camera')));
  expect(await screen.findByText('Error: invalid QR code, could not decode pair token')).toBeVisible();
  await act(async () => stream.resolve({ getTracks: () => [{ stop: camera.stop }] }));
  expect(camera.stop).toHaveBeenCalledOnce();
  expect(api.devices.pilotPair).not.toHaveBeenCalled();
});

test('a completed pairing failure is reused after Back and can be dismissed with Escape', async () => {
  api.devices.pilotPair.mockRejectedValue(new Error('403 Forbidden'));
  const app = renderPairing(`/${EXISTING}`);
  act(() => app.history.push(tokenUrl()));
  expect(await screen.findByText(/device paired with different owner/)).toHaveTextContent('please try again');
  act(() => app.history.goBack());
  act(() => app.history.goForward());
  expect(await screen.findByText(/device paired with different owner/)).toBeVisible();
  expect(api.devices.pilotPair).toHaveBeenCalledOnce();
  expect(api.devices.listDevices).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: 'Escape', keyCode: 27 });
  expect(app.history.location.search).toBe('');
});

test('leaving a pending pairing does not navigate on completion, but refreshes the shared device list', async () => {
  const pairing = deferred();
  api.devices.pilotPair.mockReturnValueOnce(pairing.promise);
  const app = renderPairing();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await act(async () => pairing.resolve({ dongle_id: PAIRED }));
  expect(app.history.location.pathname).toBe(`/${EXISTING}`);
  expect(app.history.location.search).toBe('');
  expect(app.store.getState().devices).toEqual(pairedDevices);
  expect(screen.queryByText(/Successfully paired device/)).not.toBeInTheDocument();
});

test('token transaction reuse is scoped to the current app store', async () => {
  const first = renderPairing();
  await screen.findByText(/Successfully paired device/);
  first.unmount();
  renderPairing();
  await screen.findByText(/Successfully paired device/);
  expect(api.devices.pilotPair).toHaveBeenCalledTimes(2);
});

test.each([
  ['malformed token', 'invalid-token', 'invalid QR code, could not decode pair token'],
  ['missing identity', token(null), 'could not get identity from payload'],
])('a URL with %s preserves validation and does not call the pairing API', async (_name, value, message) => {
  renderPairing(tokenUrl(value));
  expect(await screen.findByText(`Error: ${message}`)).toBeVisible();
  expect(api.devices.pilotPair).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
});

test('an unsuccessful pairing response keeps the URL error message and leaves devices unchanged', async () => {
  api.devices.pilotPair.mockResolvedValue({});
  const app = renderPairing();
  expect(await screen.findByText('Error: could not pair, please try again')).toBeVisible();
  expect(api.devices.listDevices).not.toHaveBeenCalled();
  expect(app.store.getState().devices).toBe(existingDevices);
});

test('a device-list refresh failure does not turn successful pairing into a failed pairing', async () => {
  const refreshError = new Error('Device list unavailable');
  api.devices.listDevices.mockRejectedValue(refreshError);
  const app = renderPairing();
  expect(await screen.findByText(/Successfully paired device/)).toHaveTextContent(PAIRED);
  expect(Sentry.captureException).toHaveBeenCalledWith(refreshError, { fingerprint: 'adddevice_pair_refresh_devices' });
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(app.history.location.pathname).toBe(`/${PAIRED}`);
  expect(api.devices.pilotPair).toHaveBeenCalledOnce();
});

test.each([
  ['raw QR, first device', [], `one--two--${token()}`, 'add_device_new'],
  ['URL QR, existing devices', existingDevices, `https://connect.comma.ai/?pair=${token()}`, 'add_device_sidebar'],
])('%s updates devices immediately and closes without reloading', async (_name, devices, qr, method) => {
  camera.detect.mockResolvedValueOnce([{ rawValue: qr }]);
  const deviceList = [...devices, { dongle_id: PAIRED }];
  api.devices.listDevices.mockResolvedValue(deviceList);
  const before = window.location.href;
  const app = renderPairing(`${devices.length ? `/${EXISTING}` : '/'}?dialog=pair`, devices);
  expect(await screen.findByText(/Successfully paired device/)).toBeVisible();
  expect(api.devices.pilotPair).toHaveBeenCalledExactlyOnceWith(token());
  expect(app.store.getState().devices).toEqual(deviceList);
  expect(app.actions.filter(({ type }) => type === 'analytics')).toEqual([
    { type: 'analytics', name: 'pair_device', parameters: { method } },
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'close' }));
  expect(app.history.location.pathname).toBe(`/${PAIRED}`);
  expect(app.history.location.search).toBe('');
  expect(window.location.href).toBe(before);
  expect(app.store.getState().draft).toBe(app.draft);
  expect(camera.stop).toHaveBeenCalled();
});

test('retry after an invalid QR restarts scanning and can complete the pairing', async () => {
  camera.detect.mockResolvedValueOnce([{ rawValue: 'invalid QR' }]);
  renderPairing(`/${EXISTING}?dialog=pair`);
  expect(await screen.findByText('Error: invalid QR code detected')).toBeVisible();
  expect(api.devices.pilotPair).not.toHaveBeenCalled();
  camera.detect.mockResolvedValueOnce([{ rawValue: `one--two--${token()}` }]);
  fireEvent.click(screen.getByRole('button', { name: 'try again' }));
  expect(await screen.findByText(/Successfully paired device/)).toBeVisible();
  expect(api.devices.pilotPair).toHaveBeenCalledOnce();
});

test('a failed QR pairing keeps its error wording and permits an explicit retry', async () => {
  const qr = `https://connect.comma.ai/?pair=${token()}`;
  api.devices.pilotPair.mockRejectedValueOnce(new Error('403 Forbidden'));
  camera.detect.mockResolvedValueOnce([{ rawValue: qr }]);
  renderPairing(`/${EXISTING}?dialog=pair`);
  expect(await screen.findByText(/device paired with different owner/)).not.toHaveTextContent('please try again');
  camera.detect.mockResolvedValueOnce([{ rawValue: qr }]);
  fireEvent.click(screen.getByRole('button', { name: 'try again' }));
  expect(await screen.findByText(/Successfully paired device/)).toBeVisible();
  expect(api.devices.pilotPair).toHaveBeenCalledTimes(2);
  expect(api.devices.listDevices).toHaveBeenCalledOnce();
});

test.each(['raw', 'URL'])('%s QR identity validation keeps the original version guidance', async (format) => {
  const qr = format === 'raw' ? `one--two--${token(null)}` : `https://connect.comma.ai/?pair=${token(null)}`;
  camera.detect.mockResolvedValueOnce([{ rawValue: qr }]);
  renderPairing(`/${EXISTING}?dialog=pair`);
  const error = await screen.findByText(/could not get identity from payload/);
  expect(error.textContent.includes('openpilot 0.8.3')).toBe(format === 'raw');
  expect(api.devices.pilotPair).not.toHaveBeenCalled();
});

test('consuming one token does not remove a different token stored for a later sign-in', async () => {
  localforage.getItem.mockResolvedValue(token(NEXT));
  renderPairing();
  await screen.findByText(/Successfully paired device/);
  expect(localforage.removeItem).not.toHaveBeenCalled();
});

test('legacy stored pairing resumes through a single URL-owned dialog', async () => {
  localforage.getItem.mockResolvedValue(token());
  const app = renderPairing(`/${EXISTING}`);
  expect(await screen.findByText(/Successfully paired device/)).toBeVisible();
  expect(parseLocation(app.history.location)).toMatchObject({ dialog: 'pair', pairToken: token() });
  expect(document.querySelectorAll('#add-device-modal')).toHaveLength(1);
  expect(api.devices.pilotPair).toHaveBeenCalledOnce();
});

test.each(['unchanged page', 'later user navigation'])('slow stored pairing follows startup’s default-device replacement with %s', async (scenario) => {
  const initialized = deferred();
  const stored = deferred();
  localforage.getItem.mockReturnValueOnce(stored.promise);
  startup.mockReturnValue(async (dispatch, getState) => {
    await initialized.promise;
    dispatch({ type: 'startup-data', dongleId: EXISTING });
    dispatch(replace({ ...getState().router.location, pathname: `/${EXISTING}` }));
  });
  const app = renderPairing('/');
  await act(async () => initialized.resolve());
  expect(app.history.location.pathname).toBe(`/${EXISTING}`);
  if (scenario === 'later user navigation') act(() => app.history.push(`/${NEXT}`));
  await act(async () => stored.resolve(token()));
  const resumed = scenario === 'unchanged page';
  await waitFor(() => expect(Boolean(screen.queryByText(/Successfully paired device/))).toBe(resumed));
  expect(parseLocation(app.history.location)).toMatchObject({
    dongleId: resumed ? EXISTING : NEXT, dialog: resumed ? 'pair' : null, pairToken: resumed ? token() : null,
  });
  expect(api.devices.pilotPair).toHaveBeenCalledTimes(resumed ? 1 : 0);
});

test.each(['navigation', 'unmount'])('slow legacy token storage cannot override %s', async (change) => {
  const stored = deferred();
  localforage.getItem.mockReturnValueOnce(stored.promise);
  const app = renderPairing(`/${EXISTING}`);
  if (change === 'navigation') act(() => app.history.push(`/${NEXT}`));
  else app.unmount();
  await act(async () => stored.resolve(token()));
  expect(app.history.location.search).toBe('');
  expect(app.history.location.pathname).toBe(`/${change === 'navigation' ? NEXT : EXISTING}`);
  expect(api.devices.pilotPair).not.toHaveBeenCalled();
});

test('storage failures leave a URL pairing usable and are caught', async () => {
  const storageError = new Error('Storage unavailable');
  localforage.getItem.mockRejectedValue(storageError);
  renderPairing();
  expect(await screen.findByText(/Successfully paired device/)).toBeVisible();
  expect(console.error).toHaveBeenCalledWith(storageError);
});

test('App persists the parser’s pairing token and catches asynchronous storage failure before sign-in', async () => {
  const storageError = new Error('Storage full');
  localforage.setItem.mockRejectedValue(storageError);
  const url = tokenUrl() + '&dialog=pair';
  window.history.replaceState({}, '', url);
  const app = createHarness(url);
  render(<App store={app.store} history={app.history} />);
  expect(await screen.findByText('Sign in')).toBeVisible();
  expect(localforage.setItem).toHaveBeenCalledExactlyOnceWith('pairToken', token());
  expect(console.error).toHaveBeenCalledWith(storageError);
  expect(api.devices.pilotPair).not.toHaveBeenCalled();
});

test('App does not persist a pair query that the route parser does not recognize as pairing', async () => {
  const url = `/${EXISTING}?dialog=settings&pair=${token()}`;
  window.history.replaceState({}, '', url);
  const app = createHarness(url);
  render(<App store={app.store} history={app.history} />);
  expect(await screen.findByText('Sign in')).toBeVisible();
  expect(localforage.setItem).not.toHaveBeenCalled();
  expect(api.devices.pilotPair).not.toHaveBeenCalled();
});
