import { vi } from 'vitest';
import { api } from '../api/backend';
import { fetchFiles } from './files';
import { ACTION_FILES_URLS } from './types';

vi.mock('../api/backend', () => ({ api: { routes: { getRouteFiles: vi.fn() } } }));
vi.mock('../api', () => ({ athena: {} }));
vi.mock('./index', () => ({ updateDeviceOnline: vi.fn(), fetchDeviceNetworkStatus: vi.fn() }));

const PUBLIC_ROUTE = '5beb9b58bd12b691|0000010a--a51155e496';
const DEMO_ROUTE = 'deadbeefdeadbeef|00000000--0000000011';
const SIGNED_URL = 'https://commadataci.blob.core.windows.net/openpilotci/5beb9b58bd12b691/0000010a--a51155e496/12/fcamera.hevc?sig=example%2Fsignature%3D&next=%2F99%2Frlog.zst';

beforeEach(() => vi.clearAllMocks());

test.each([
  ['signed public URL', PUBLIC_ROUTE, 'cameras', SIGNED_URL, 12],
  ['cloned route alias', DEMO_ROUTE, 'cameras', SIGNED_URL, 12],
  ['local synthetic URL', DEMO_ROUTE, 'qcameras', 'http://localhost:3000/demo-video/2/qcamera.ts', 2],
])('fetchFiles maps a %s to the requested route without rewriting the URL', async (_name, route, type, url, segment) => {
  api.routes.getRouteFiles.mockResolvedValue({ [type]: [url] });
  const dispatch = vi.fn();

  await fetchFiles(route, true)(dispatch);

  expect(api.routes.getRouteFiles).toHaveBeenCalledWith(route, true);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch).toHaveBeenCalledWith({
    type: ACTION_FILES_URLS,
    dongleId: route.split('|')[0],
    urls: { [`${route}--${segment}/${type}`]: { url } },
  });
});
