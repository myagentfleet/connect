import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { athena as Athena } from '../api';
import { cancelFetchUploadQueue, fetchUploadQueue } from './files';
import { ACTION_FILES_UPLOADING } from './types';

vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));
vi.mock('../api', () => ({ athena: { postJsonRpcPayload: vi.fn() } }));
vi.mock('../api/backend', () => ({ api: {} }));
vi.mock('./index', () => ({
  updateDeviceOnline: (dongleId, time) => ({ type: 'DEVICE_ONLINE', dongleId, time }),
  fetchDeviceNetworkStatus: (dongleId) => ({ type: 'DEVICE_NETWORK', dongleId }),
}));
vi.mock('../utils', () => ({
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  cancelFetchUploadQueue();
});

afterEach(() => {
  cancelFetchUploadQueue();
  vi.useRealTimers();
});

describe('upload queue ownership', () => {
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
