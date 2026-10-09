import React, { useEffect, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory } from 'history';
import { routerMiddleware } from 'connected-react-router';

import ClipMenu from './ClipMenu';
import { clipDevice } from '../../api/clips';
import { closeDialog } from '../../actions/navigation';
import { parseLocation } from '../../url';

vi.mock('../../api/clips', () => ({ clipDevice: {
  getClipState: vi.fn(), hasClipBlob: vi.fn(), getClipUrl: vi.fn(), createClip: vi.fn(), deleteClip: vi.fn(),
} }));

const FIRST = 'aaaaaaaaaaaaaaaa';
const SECOND = 'bbbbbbbbbbbbbbbb';
const LOG = '2026-08-06--12-00-00';
const clips = ['first.mp4', 'second.mp4'].map((filename, index) => ({
  filename, status: 'ready', requested_at: index + 1, route: LOG, camera: 'fcamera.hevc',
  source_start_time: 0, source_end_time: 20, speedup: 1, size: 100,
}));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function renderClips(url, options = {}) {
  const history = createMemoryHistory({ initialEntries: [url] });
  const applyHistory = routerMiddleware(history)({})(action => action);
  const getState = () => ({ router: { location: history.location } });
  const dispatch = action => typeof action === 'function' ? action(dispatch, getState) : applyHistory(action);

  const Harness = () => {
    const [location, setLocation] = useState(history.location);
    useEffect(() => history.listen(setLocation), []);
    const navigation = parseLocation(location);
    return (
      <ClipMenu
        dongleId={navigation.dongleId}
        dialog={navigation.dialog}
        dialogClip={navigation.dialogClip}
        open={['clips', 'clip', 'delete-clip'].includes(navigation.dialog)}
        onClose={() => dispatch(closeDialog())}
        dispatch={dispatch}
        deviceOnline
        inventoryOnly={navigation.page !== 'drive'}
        route={navigation.logId ? { fullname: `${navigation.dongleId}|${navigation.logId}` } : null}
        zoom={navigation.range || { start: 0, end: 20000 }}
        {...options}
      />
    );
  };
  return { ...render(<Harness />), history };
}

beforeAll(() => {
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

beforeEach(() => {
  vi.clearAllMocks();
  clipDevice.getClipState.mockReset().mockResolvedValue({ clips });
  clipDevice.hasClipBlob.mockReset().mockResolvedValue(false);
  clipDevice.getClipUrl.mockReset().mockImplementation(async (_dongleId, filename) => `blob:${filename}`);
  clipDevice.createClip.mockReset().mockResolvedValue({});
  clipDevice.deleteClip.mockReset().mockResolvedValue({});
});

test('a cold viewer URL shows inventory and preview loading before playback, then closes to clips', async () => {
  const inventory = deferred();
  const preview = deferred();
  clipDevice.getClipState.mockReturnValueOnce(inventory.promise);
  clipDevice.getClipUrl.mockReturnValueOnce(preview.promise);
  const { history } = renderClips(`/${FIRST}?dialog=clip&clip=first.mp4`);
  expect(screen.getByRole('dialog', { name: 'first' })).toBeVisible();
  expect(await screen.findByLabelText('Loading clips')).toBeVisible();
  await act(async () => inventory.resolve({ clips }));
  expect(await screen.findByText('Downloading · 0%')).toBeVisible();
  act(() => clipDevice.getClipUrl.mock.calls[0][3](5, 10));
  expect(screen.getByText('Downloading · 50%')).toBeVisible();
  await act(async () => preview.resolve('blob:preview'));
  expect(document.querySelector('video')).toHaveAttribute('src', 'blob:preview');
  expect(clipDevice.createClip).not.toHaveBeenCalled();
  expect(clipDevice.deleteClip).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close video' }));
  expect(history.location.search).toBe('?dialog=clips');
  expect(await screen.findByText('CLIPS ON THIS DEVICE')).toBeVisible();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
});

test.each([
  ['offline', 'Device offline'],
  ['missing', 'Clip not found on this device.'],
  ['inventory-error', 'Inventory unavailable'],
  ['preview-error', 'Preview unavailable'],
])('a cold viewer URL displays its %s state without mutating the device', async (scenario, message) => {
  if (scenario === 'missing') clipDevice.getClipState.mockResolvedValue({ clips: [] });
  if (scenario === 'inventory-error') clipDevice.getClipState.mockRejectedValue(new Error(message));
  if (scenario === 'preview-error') clipDevice.getClipUrl.mockRejectedValue(new Error(message));
  renderClips(`/${FIRST}?dialog=clip&clip=first.mp4`, { deviceOnline: scenario !== 'offline' });
  expect(await screen.findByText(message)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Download clip' })).toBeDisabled();
  expect(clipDevice.createClip).not.toHaveBeenCalled();
  expect(clipDevice.deleteClip).not.toHaveBeenCalled();
});

test('viewer Close, Escape, Back and Forward preserve the clip creation form and inventory', async () => {
  clipDevice.hasClipBlob.mockResolvedValue(true);
  const { history } = renderClips(`/${FIRST}/${LOG}/0/20?dialog=clips`);
  fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'unsaved-name' } });
  fireEvent.click(screen.getByRole('button', { name: /High/ }));
  fireEvent.click((await screen.findAllByRole('button', { name: 'Play clip' }))[0]);
  await waitFor(() => expect(document.querySelector('video')).toHaveAttribute('src', 'blob:first.mp4'));
  expect(history.location.search).toBe('?dialog=clip&clip=first.mp4');
  fireEvent.click(screen.getByRole('button', { name: 'Close video' }));
  expect(await screen.findByRole('textbox')).toHaveValue('unsaved-name');
  expect(screen.getByRole('button', { name: /High/ })).toHaveAttribute('aria-pressed', 'true');
  act(() => history.goBack());
  expect(await screen.findByRole('button', { name: 'Close video' })).toBeVisible();
  act(() => history.goBack());
  expect(await screen.findByRole('textbox')).toHaveValue('unsaved-name');
  act(() => history.goForward());
  expect(await screen.findByRole('button', { name: 'Close video' })).toBeVisible();
  fireEvent.keyDown(document, { key: 'Escape', keyCode: 27 });
  expect(await screen.findByRole('textbox')).toHaveValue('unsaved-name');
  expect(clipDevice.getClipState).toHaveBeenCalledOnce();
  expect(clipDevice.getClipUrl.mock.calls.every(([dongleId, filename, requestedAt]) => (
    dongleId === FIRST && filename === 'first.mp4' && requestedAt === 1
  ))).toBe(true);
});

test.each([
  [`/${FIRST}?dialog=clips`, 'CLIPS ON THIS DEVICE'],
  [`/${FIRST}/${LOG}?dialog=clips`, 'Create a clip'],
])('the named clips panel keeps keyboard navigation native at %s', async (url, title) => {
  const { history } = renderClips(url);
  expect(await screen.findByRole('dialog', { name: title })).toBeVisible();
  const control = screen.queryByRole('textbox') || (await screen.findAllByRole('button', { name: 'Download clip' }))[0];
  control.focus();
  // fireEvent does not move focus like a browser's Tab key, but it does expose
  // the Menu regression: preventing the default and dismissing the panel.
  expect(fireEvent.keyDown(control, { key: 'Tab', keyCode: 9 })).toBe(true);
  expect(fireEvent.keyDown(control, { key: 'Tab', keyCode: 9, shiftKey: true })).toBe(true);
  expect(fireEvent.keyDown(control, { key: 'ArrowDown', keyCode: 40 })).toBe(true);
  expect(history.location.search).toBe('?dialog=clips');
  expect(screen.getByRole('dialog', { name: title })).toBeVisible();
  fireEvent.keyDown(control, { key: 'Escape', keyCode: 27 });
  expect(history.location.search).toBe('');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: title })).not.toBeInTheDocument());
});

test('inventory growth repositions the open panel within the viewport', async () => {
  const inventory = deferred();
  clipDevice.getClipState.mockReturnValueOnce(inventory.promise);
  const anchorEl = document.createElement('button');
  document.body.appendChild(anchorEl);
  anchorEl.getBoundingClientRect = () => ({ top: window.innerHeight - 150, left: 500, height: 20, width: 20 });
  const { unmount } = renderClips(`/${FIRST}?dialog=clips`, { anchorEl });
  try {
    const panel = screen.getByRole('dialog', { name: 'CLIPS ON THIS DEVICE' });
    // jsdom has no layout; expose the dimensions before and after inventory
    // growth so the installed Popover's positioning calculation runs normally.
    let height = 100;
    Object.defineProperty(panel, 'clientHeight', { get: () => height });
    Object.defineProperty(panel, 'clientWidth', { value: 360 });
    fireEvent(window, new Event('resize'));
    await waitFor(() => expect(panel.style.top).toBe(`${window.innerHeight - 150}px`));

    height = 400;
    await act(async () => inventory.resolve({ clips }));
    await waitFor(() => expect(panel.style.top).toBe(`${window.innerHeight - 16 - height}px`));
  } finally {
    unmount();
    anchorEl.remove();
  }
});

test.each(['clip', 'device', 'close', 'unmount'])('discards a late preview after %s changes', async (change) => {
  const preview = deferred();
  clipDevice.getClipUrl.mockReturnValueOnce(preview.promise);
  const { history, unmount } = renderClips(`/${FIRST}?dialog=clip&clip=first.mp4`);
  await waitFor(() => expect(clipDevice.getClipUrl).toHaveBeenCalledOnce());
  if (change === 'clip') act(() => history.push(`/${FIRST}?dialog=clip&clip=second.mp4`));
  if (change === 'device') act(() => history.push(`/${SECOND}?dialog=clip&clip=first.mp4`));
  if (change === 'close') fireEvent.click(screen.getByRole('button', { name: 'Close video' }));
  if (change === 'unmount') unmount();
  const newPreview = change === 'clip' || change === 'device';
  const filename = change === 'clip' ? 'second.mp4' : 'first.mp4';
  await waitFor(() => expect(clipDevice.getClipUrl).toHaveBeenCalledTimes(newPreview ? 2 : 1));
  await waitFor(() => expect(document.querySelector('video')?.getAttribute('src') || null).toBe(newPreview ? `blob:${filename}` : null));
  await act(async () => preview.resolve('blob:stale'));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:stale');
  expect(document.querySelector('video[src="blob:stale"]')).toBeNull();
});

test('a cold deletion URL requires confirmation and closes to clips after deletion', async () => {
  const { history } = renderClips(`/${FIRST}?dialog=delete-clip&clip=first.mp4`);
  expect(await screen.findByRole('heading', { name: 'Delete clip?' })).toBeVisible();
  expect(screen.getByRole('dialog', { name: 'Delete clip?' })).toBeVisible();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled());
  expect(clipDevice.deleteClip).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(history.location.search).toBe('?dialog=clips'));
  expect(clipDevice.deleteClip).toHaveBeenCalledExactlyOnceWith(FIRST, { filename: 'first.mp4' });
});

test('deletion Cancel, Escape and URL navigation dismiss the confirmation without deleting', async () => {
  const { history } = renderClips(`/${FIRST}?dialog=delete-clip&clip=first.mp4`);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled());
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  expect(history.location.search).toBe('?dialog=clips');
  act(() => history.goBack());
  expect(await screen.findByRole('heading', { name: 'Delete clip?' })).toBeVisible();
  fireEvent.keyDown(document, { key: 'Escape', keyCode: 27 });
  expect(history.location.search).toBe('?dialog=clips');
  act(() => history.goBack());
  expect(await screen.findByRole('heading', { name: 'Delete clip?' })).toBeVisible();
  act(() => history.push(`/${FIRST}`));
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Delete clip?' })).not.toBeInTheDocument());
  expect(clipDevice.deleteClip).not.toHaveBeenCalled();
});

test('Back and Forward preserve an in-flight deletion without submitting it twice', async () => {
  const deletion = deferred();
  clipDevice.deleteClip.mockReturnValueOnce(deletion.promise);
  const { history } = renderClips(`/${FIRST}?dialog=clips`);
  fireEvent.click((await screen.findAllByRole('button', { name: 'Delete clip' }))[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  act(() => history.goBack());
  expect(await screen.findByText('CLIPS ON THIS DEVICE')).toBeVisible();
  act(() => history.goForward());
  expect(await screen.findByRole('heading', { name: 'Delete clip?' })).toBeVisible();
  const buttons = screen.getAllByRole('button');
  expect(buttons).toHaveLength(2);
  expect(buttons.every(button => button.disabled)).toBe(true);
  fireEvent.click(buttons[1]);
  expect(clipDevice.deleteClip).toHaveBeenCalledOnce();
  await act(async () => deletion.resolve({}));
  expect(history.location.search).toBe('?dialog=clips');
});

test.each(['success', 'failure'])('a stale deletion %s cannot close or change a newer clip confirmation', async (result) => {
  const deletion = deferred();
  clipDevice.deleteClip.mockReturnValueOnce(deletion.promise);
  const { history } = renderClips(`/${FIRST}?dialog=delete-clip&clip=first.mp4`);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  act(() => history.push(`/${FIRST}?dialog=delete-clip&clip=second.mp4`));
  await act(async () => {
    if (result === 'success') deletion.resolve({});
    else deletion.reject(new Error('Old deletion failed'));
  });
  expect(history.location.search).toBe('?dialog=delete-clip&clip=second.mp4');
  expect(screen.getByRole('heading', { name: 'Delete clip?' })).toBeVisible();
  expect(screen.queryByText('Old deletion failed')).not.toBeInTheDocument();
});

test.each([
  ['inventory', 'success'],
  ['blob lookup', 'success'],
  ['inventory', 'failure'],
])('a stale %s %s cannot replace the newest inventory after A to B to A', async (stage, result) => {
  const previous = deferred();
  const oldClip = { ...clips[0], filename: 'old.mp4' };
  const newestClip = { ...clips[0], filename: 'newest.mp4' };
  if (stage === 'blob lookup') {
    clipDevice.getClipState.mockResolvedValueOnce({ clips: [oldClip] });
    clipDevice.hasClipBlob.mockReturnValueOnce(previous.promise);
  } else {
    clipDevice.getClipState.mockReturnValueOnce(previous.promise);
  }
  const { history } = renderClips(`/${FIRST}/${LOG}?dialog=clips`);
  await waitFor(() => expect(clipDevice.getClipState).toHaveBeenCalledOnce());
  const blobLookups = stage === 'blob lookup' ? 1 : 0;
  await waitFor(() => expect(clipDevice.hasClipBlob).toHaveBeenCalledTimes(blobLookups));

  clipDevice.getClipState.mockResolvedValue({ clips: [newestClip] });
  act(() => history.push(`/${FIRST}/2026-08-06--13-00-00?dialog=clips`));
  expect(await screen.findByText('newest')).toBeVisible();
  act(() => history.goBack());
  await waitFor(() => expect(clipDevice.getClipState).toHaveBeenCalledTimes(3));
  expect(await screen.findByText('newest')).toBeVisible();

  await act(async () => {
    if (result === 'failure') previous.reject(new Error('Old inventory failed'));
    else previous.resolve(stage === 'blob lookup' ? false : { clips: [oldClip] });
  });
  expect(screen.getByText('newest')).toBeVisible();
  expect(screen.queryByText('old')).not.toBeInTheDocument();
  expect(screen.queryByText('Old inventory failed')).not.toBeInTheDocument();
  expect(history.location.search).toBe('?dialog=clips');
});

test.each([
  ['route', FIRST, '2026-08-06--13-00-00', 'success'],
  ['route', FIRST, '2026-08-06--13-00-00', 'failure'],
  ['device', SECOND, LOG, 'success'],
  ['device', SECOND, LOG, 'failure'],
])('a stale creation after a %s change to %s/%s cannot apply its %s to the new form', async (_change, dongleId, logId, result) => {
  const previous = deferred();
  const current = deferred();
  const cameras = { 'fcamera.hevc': { available_ranges: [[0, 20]] } };
  clipDevice.getClipState.mockResolvedValue({ clips: [], cameras });
  clipDevice.createClip.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
  const { history } = renderClips(`/${FIRST}/${LOG}?dialog=clips`);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create clip' })).toBeEnabled());
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'first' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create clip' }));

  // The new inventory deliberately contains the old requested filename.
  // A retained auto-download target must not open that unrelated clip.
  clipDevice.getClipState.mockResolvedValue({ clips, cameras });
  act(() => history.push(`/${dongleId}/${logId}?dialog=clips`));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create clip' })).toBeEnabled());
  expect(history.location.search).toBe('?dialog=clips');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'second' } });
  const createButton = screen.getByRole('button', { name: 'Create clip' });
  fireEvent.click(createButton);
  expect(clipDevice.createClip).toHaveBeenLastCalledWith(dongleId, expect.objectContaining({ route: `${dongleId}|${logId}` }));

  await act(async () => {
    if (result === 'success') previous.resolve({});
    else previous.reject(new Error('Previous creation failed'));
  });
  expect(createButton).toBeDisabled();
  expect(screen.queryByText('Previous creation failed')).not.toBeInTheDocument();
  expect(clipDevice.getClipState).toHaveBeenCalledTimes(2);
  expect(history.location.search).toBe('?dialog=clips');

  await act(async () => current.reject(new Error('Current creation failed')));
  expect(await screen.findByText('Current creation failed')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Create clip' })).toBeEnabled();
});

test('dialog-only Back and Forward retain pending clip creation and its automatic preview', async () => {
  const creation = deferred();
  const cameras = { 'fcamera.hevc': { available_ranges: [[0, 20]] } };
  clipDevice.getClipState.mockResolvedValue({ clips: [], cameras });
  clipDevice.createClip.mockReturnValueOnce(creation.promise);
  const pathname = `/${FIRST}/${LOG}`;
  const { history } = renderClips(pathname);
  act(() => history.push(`${pathname}?dialog=clips`));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create clip' })).toBeEnabled());
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'first' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create clip' }));
  // An older ready clip with the requested filename must not be previewed while
  // the new creation is still awaiting acceptance by the device.
  clipDevice.getClipState.mockResolvedValue({ clips, cameras });
  act(() => history.goBack());
  act(() => history.goForward());
  expect(await screen.findAllByRole('button', { name: 'Download clip' })).toHaveLength(2);
  expect(history.location.search).toBe('?dialog=clips');
  expect(await screen.findByRole('textbox')).toHaveValue('first');
  expect(screen.queryByRole('button', { name: 'Create clip' })).not.toBeInTheDocument();
  expect(clipDevice.createClip).toHaveBeenCalledOnce();

  await act(async () => creation.resolve({}));
  await waitFor(() => expect(history.location.search).toBe('?dialog=clip&clip=first.mp4'));
  expect(await screen.findByRole('button', { name: 'Close video' })).toBeVisible();
  expect(clipDevice.createClip).toHaveBeenCalledOnce();
});
