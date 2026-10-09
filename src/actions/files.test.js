import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Provider } from 'react-redux';
import { act, render, screen } from '@testing-library/react';
import { applyMiddleware, createStore } from 'redux';
import thunk from 'redux-thunk';

import { athena as Athena } from '../api';
import { api } from '../api/backend';
import { createInitialState } from '../initialState';
import rootReducer from '../reducers';
import { parseLocation } from '../url';
import { deviceVersionAtLeast } from '../utils';
import UploadQueue from '../components/Files/UploadQueue';
import { cancelFetchUploadQueue, cancelUploads, doUpload, fetchAthenaQueue, fetchFiles, fetchUploadQueue } from './files';
import { ACTION_FILES_UPLOADING, ACTION_NAVIGATE } from './types';

vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));
vi.mock('../api', () => ({ athena: { postJsonRpcPayload: vi.fn() } }));
vi.mock('../api/backend', () => ({ api: {
  routes: { getRouteFiles: vi.fn() }, devices: { getAthenaQueue: vi.fn() },
} }));
vi.mock('../store', () => ({ default: { getState: vi.fn() } }));
vi.mock('./index', () => ({
  updateDeviceOnline: (dongleId, time) => ({ type: 'DEVICE_ONLINE', dongleId, time }),
  fetchDeviceNetworkStatus: (dongleId) => ({ type: 'DEVICE_NETWORK', dongleId }),
}));
vi.mock('../utils', () => ({
  emptyDevice: {},
  deviceIsOnline: () => true,
  deviceOnCellular: () => false,
  getDeviceFromState: () => ({}),
  deviceVersionAtLeast: vi.fn(),
  asyncSleep: vi.fn(),
}));

const FIRST = 'aaaaaaaaaaaaaaaa';
const SECOND = 'bbbbbbbbbbbbbbbb';
const LOG = '2026-08-06--12-00-00';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function queue(dongleId) {
  return { result: [{
    id: dongleId, current: true, progress: 0.5, created_at: 1,
    url: `https://uploads.example.com/${dongleId}/${LOG}/0/fcamera.hevc`,
  }] };
}

function harness(state = { dongleId: SECOND, filesUploading: {} }) {
  const getState = () => state;
  const dispatch = vi.fn((action) => (typeof action === 'function' ? action(dispatch, getState) : action));
  return { dispatch, load: (dongleId) => dispatch(fetchUploadQueue(dongleId)) };
}

function deviceStore(fields = {}) {
  return createStore(rootReducer, {
    ...createInitialState({ pathname: `/${FIRST}` }),
    devices: [{ dongle_id: FIRST }, { dongle_id: SECOND }],
    ...fields,
  }, applyMiddleware(thunk));
}

function navigate(store, dongleId) {
  store.dispatch({ type: ACTION_NAVIGATE, navigation: parseLocation(`/${dongleId}`) });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  deviceVersionAtLeast.mockReturnValue(true);
  cancelFetchUploadQueue();
});

afterEach(() => {
  cancelFetchUploadQueue();
  vi.useRealTimers();
});

describe('upload queue ownership', () => {
  it.each([false, true])('applies a completed cancellation to its device (returned before response: %s)', async (returned) => {
    const firstFile = `${FIRST}|${LOG}--0/cameras`;
    const retainedFile = `${FIRST}|${LOG}--1/cameras`;
    const secondFile = `${SECOND}|${LOG}--0/cameras`;
    const firstUploads = {
      'first-id': { fileName: firstFile, progress: 0 },
      'retained-id': { fileName: retainedFile, progress: 0.5 },
    };
    const firstFiles = { [firstFile]: { progress: 0 }, [retainedFile]: { progress: 0.5 } };
    const store = deviceStore({
      filesUploading: firstUploads,
      filesUploadingMeta: { dongleId: FIRST },
      files: firstFiles,
    });
    const response = deferred();
    Athena.postJsonRpcPayload.mockReturnValueOnce(response.promise);
    const pending = store.dispatch(cancelUploads(FIRST, ['first-id']));
    navigate(store, SECOND);
    store.dispatch({
      type: ACTION_FILES_UPLOADING, dongleId: SECOND,
      uploading: { 'second-id': { fileName: secondFile, progress: 0.25 } },
      files: { [secondFile]: { progress: 0.25 } },
    });
    const secondState = store.getState();
    if (returned) navigate(store, FIRST);

    response.resolve({ result: { success: true } });
    await pending;
    const other = returned ? store.getState().deviceCache[SECOND] : store.getState();
    if (!returned) navigate(store, FIRST);
    expect(store.getState().filesUploading).toEqual({ 'retained-id': firstUploads['retained-id'] });
    expect(store.getState().files).toEqual({ [retainedFile]: firstFiles[retainedFile] });
    expect(other.filesUploading).toBe(secondState.filesUploading);
    expect(other.filesUploadingMeta).toBe(secondState.filesUploadingMeta);
    expect(other.files).toBe(secondState.files);
    expect(store.getState().filesUploading['retained-id']).toBe(firstUploads['retained-id']);
    expect(store.getState().files[retainedFile]).toBe(firstFiles[retainedFile]);
    expect(firstUploads).toHaveProperty('first-id');
    expect(firstFiles).toHaveProperty(firstFile);
    expect(Athena.postJsonRpcPayload).toHaveBeenCalledExactlyOnceWith(FIRST, expect.objectContaining({
      method: 'cancelUpload', params: { upload_id: ['first-id'] },
    }));
  });

  it('retains file URLs received while another device is selected', async () => {
    const routeName = `${FIRST}|${LOG}`;
    const url = `https://uploads.example.com/${FIRST}/${LOG}/0/fcamera.hevc`;
    const response = deferred();
    api.routes.getRouteFiles.mockReturnValueOnce(response.promise);
    const store = deviceStore();
    const pending = store.dispatch(fetchFiles(routeName));
    navigate(store, SECOND);
    const secondFiles = store.getState().files;
    response.resolve({ cameras: [url] });
    await pending;
    expect(store.getState().files).toBe(secondFiles);
    navigate(store, FIRST);
    expect(store.getState().files).toEqual({ [`${routeName}--0/cameras`]: { url } });
  });

  it.each(['upload', 'offline queue'])('retains a delayed %s result on its originating device', async (operation) => {
    const path = `${LOG}--0/fcamera.hevc`;
    const response = deferred();
    const store = deviceStore();
    let pending;
    if (operation === 'upload') {
      Athena.postJsonRpcPayload.mockReturnValueOnce(response.promise);
      pending = store.dispatch(doUpload(FIRST, [path], ['https://uploads.example.com/file']));
    } else {
      api.devices.getAthenaQueue.mockReturnValueOnce(response.promise);
      pending = store.dispatch(fetchAthenaQueue(FIRST));
    }
    navigate(store, SECOND);
    const secondFiles = store.getState().files;
    response.resolve(operation === 'upload' ? { result: 'Device offline, message queued' } : [{
      method: 'uploadFilesToUrls', expiry: Math.floor(Date.now() / 1000) + 60,
      params: { files_data: [{ fn: path }] },
    }]);
    await pending;
    expect(store.getState().files).toBe(secondFiles);
    navigate(store, FIRST);
    expect(store.getState().files).toEqual({ [`${FIRST}|${LOG}--0/cameras`]: { progress: 0, current: false } });
  });

  it('shows and refreshes the requested device queue while another device page stays selected', async () => {
    const firstFile = `${FIRST}|${LOG}--0/cameras`;
    const secondFile = `${SECOND}|${LOG}--0/cameras`;
    const url = `https://uploads.example.com/${SECOND}/${LOG}/0/fcamera.hevc`;
    const store = deviceStore({
      files: { [firstFile]: { progress: 0.25 } },
      filesUploading: { 'first-id': { fileName: firstFile, current: true, progress: 0.25 } },
      filesUploadingMeta: { dongleId: FIRST, fetchedAt: 1 },
    });
    const firstState = store.getState();
    Athena.postJsonRpcPayload.mockResolvedValueOnce(queue(SECOND)).mockResolvedValueOnce({ result: [] });
    api.routes.getRouteFiles.mockResolvedValueOnce({ cameras: [url] });
    const view = render(React.createElement(Provider, { store }, React.createElement(UploadQueue, {
      open: true, update: true, device: { dongle_id: SECOND }, onClose: vi.fn(),
    })));
    await act(async () => {});
    expect(screen.getByRole('dialog', { name: 'Upload queue' })).toHaveTextContent(SECOND);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    expect(store.getState().dongleId).toBe(FIRST);
    expect(store.getState().filesUploading).toBe(firstState.filesUploading);
    expect(store.getState().files).toBe(firstState.files);

    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(api.routes.getRouteFiles).toHaveBeenCalledExactlyOnceWith(`${SECOND}|${LOG}`, true);
    expect(store.getState().deviceCache[SECOND].filesUploading).toEqual({});
    expect(store.getState().deviceCache[SECOND].files[secondFile]).toEqual({ url });
    expect(store.getState().filesUploading).toBe(firstState.filesUploading);
    expect(store.getState().files).toBe(firstState.files);
    view.unmount();
  });

  it.each([FIRST, SECOND])('does not mutate retained uploads while polling %s', async (dongleId) => {
    const uploads = Object.freeze({
      [dongleId]: Object.freeze({ fileName: `${SECOND}|${LOG}--0/fcamera`, progress: 0.25 }),
    });
    const store = harness({
      dongleId: SECOND, filesUploading: uploads, filesUploadingMeta: { dongleId: SECOND },
    });
    Athena.postJsonRpcPayload.mockResolvedValue(queue(dongleId));
    await store.load(dongleId);
    expect(Object.keys(uploads)).toEqual([dongleId]);
    expect(uploads[dongleId].progress).toBe(0.25);
    expect(store.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: ACTION_FILES_UPLOADING, dongleId,
    }));
  });

  it.each([
    { status: 'successful', oldResult: queue(FIRST), order: 'before' },
    { status: 'successful', oldResult: queue(FIRST), order: 'after' },
    { status: 'offline', oldResult: { offline: true }, order: 'before' },
    { status: 'offline', oldResult: { offline: true }, order: 'after' },
  ])('ignores an old $status response arriving $order the new response', async ({ oldResult, order }) => {
    const first = deferred();
    const second = deferred();
    Athena.postJsonRpcPayload.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      .mockResolvedValue({ result: [] });
    const store = harness();
    const oldPending = store.load(FIRST);
    cancelFetchUploadQueue();
    const newPending = store.load(SECOND);
    store.dispatch.mockClear();

    if (order === 'after') {
      second.resolve(queue(SECOND));
      await newPending;
    }
    const callsBeforeOld = store.dispatch.mock.calls.length;
    first.resolve(oldResult);
    await oldPending;
    expect(store.dispatch).toHaveBeenCalledTimes(callsBeforeOld);

    if (order === 'before') {
      second.resolve(queue(SECOND));
      await newPending;
    }
    expect(store.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: ACTION_FILES_UPLOADING, dongleId: SECOND,
    }));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(Athena.postJsonRpcPayload.mock.calls.map(([dongleId]) => dongleId))
      .toEqual([FIRST, SECOND, SECOND]);
  });

  it('does not publish or restart polling after the dialog closes', async () => {
    const response = deferred();
    Athena.postJsonRpcPayload.mockReturnValue(response.promise);
    const store = harness();
    const pending = store.load(FIRST);
    cancelFetchUploadQueue();
    store.dispatch.mockClear();
    response.resolve(queue(FIRST));
    await pending;
    expect(store.dispatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
