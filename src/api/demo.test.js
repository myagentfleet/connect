import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createDemoBackend, DEMO_DONGLE_ID, PUBLIC_ROUTE_DONGLE_ID, PUBLIC_ROUTE_LOG_ID } from './demo';

const PUBLIC_ROUTE = `${PUBLIC_ROUTE_DONGLE_ID}|${PUBLIC_ROUTE_LOG_ID}`;
const START = 1700000000000;
const assetRoot = resolve('public/demo-video');

function readAsset(path) {
  return readFileSync(resolve(assetRoot, path), 'utf8');
}

function makeBackend() {
  const route = {
    fullname: PUBLIC_ROUTE,
    url: `https://example.com/${PUBLIC_ROUTE_LOG_ID}`,
    share_exp: '123',
    share_sig: 'signature',
    start_time_utc_millis: START,
    end_time_utc_millis: START + 300000,
    segment_numbers: [0, 1, 2, 3, 4],
    segment_start_times: [0, 1, 2, 3, 4].map((segment) => START + segment * 60000),
    segment_end_times: [1, 2, 3, 4, 5].map((segment) => START + segment * 60000),
    maxqlog: 4,
  };
  const real = {
    routes: {
      getRoutesSegments: vi.fn(async () => [route]),
      getRouteFiles: vi.fn(async () => ({ qcameras: [0, 1, 2, 3, 4].map((segment) => `${route.url}/${segment}/qcamera.ts`) })),
    },
    video: { getQcameraStreamUrl: vi.fn((name) => `https://example.com/${name}/qcamera.m3u8`) },
    routeAssets: Object.fromEntries(['events', 'coords', 'thumbnail'].map((type) => [type, vi.fn(() => `${type}-url`)])),
  };
  return { real, route, demo: createDemoBackend(real) };
}

describe('demo playback fixtures', () => {
  it('preserves existing route IDs and fixes the missing-segment stream itself', async () => {
    const { real, demo } = makeBackend();
    const routes = await demo.routes.getRoutesSegments(DEMO_DONGLE_ID);

    expect(routes).toHaveLength(13);
    expect(routes[0].fullname).toBe(`${DEMO_DONGLE_ID}|00000000--0000000001`);
    expect(routes[9].demo_title).toBe('Missing thumbnails (1 segment)');
    expect(demo.video.getQcameraStreamUrl(routes[7].fullname)).toBe(`${window.location.origin}/demo-video/missing-middle.m3u8`);

    // Unmodified clones still request the real public stream and preserve its credentials.
    const intact = routes[2];
    demo.video.getQcameraStreamUrl(intact.fullname, intact.share_exp, intact.share_sig);
    expect(real.video.getQcameraStreamUrl).toHaveBeenLastCalledWith(PUBLIC_ROUTE, '123', 'signature');
  });

  it.each([
    [10, 'complete', null],
    [11, 'missing-first', 0],
    [12, 'missing-middle', 1],
  ])('keeps media, metadata and file availability aligned for route %i (%s)', async (index, name, missingSegment) => {
    const { demo } = makeBackend();
    const routes = await demo.routes.getRoutesSegments(DEMO_DONGLE_ID);
    const route = routes[index];
    const src = demo.video.getQcameraStreamUrl(route.fullname);
    const files = await demo.routes.getRouteFiles(route.fullname);

    expect(src).toBe(`${window.location.origin}/demo-video/${name}.m3u8`);
    expect(route.segment_numbers).toEqual([0, 1, 2]);
    expect(route.segment_start_times).toEqual([START, START + 60000, START + 120000]);
    expect(route.segment_end_times).toEqual([START + 60000, START + 120000, START + 180000]);
    expect(route.end_time_utc_millis - route.start_time_utc_millis).toBe(180000);
    expect(route.maxqlog).toBe(2);
    expect(route.videoStartOffset).toBe(0);
    expect(route.share_sig).toBeUndefined();
    expect(files.qcameras).toEqual([0, 1, 2]
      .filter((segment) => segment !== missingSegment)
      .map((segment) => `${window.location.origin}/demo-video/${segment}/qcamera.ts`));

    // The playlist retains all three durations. It does not silently shorten a route
    // or use an HLS.js-only loader/EXT-X-GAP to bypass the failing HTTP request.
    const manifest = readAsset(`${name}.m3u8`).trim().split('\n');
    expect(manifest.filter((line) => line.startsWith('#EXTINF:')).map((line) => parseFloat(line.slice(8)))).toEqual([60, 60, 60]);
    expect(manifest).toContain('#EXT-X-ENDLIST');
    expect(manifest).not.toContain('#EXT-X-GAP');
    const media = manifest.filter((line) => !line.startsWith('#'));
    expect(media).toHaveLength(3);
    const missingUris = media.filter((uri) => uri.startsWith('https:'));
    expect(missingUris).toHaveLength(missingSegment === null ? 0 : 1);
    missingUris.forEach((uri) => {
      const url = new URL(uri);
      expect(url.origin).toBe('https://chffrprivate.blob.core.windows.net');
      expect(url.pathname).toContain('00000000--0000000008');
      expect(url.pathname.endsWith(`/${missingSegment}/qcamera.ts`)).toBe(true);
      expect(url.search).toBe('');
    });
    const availableUris = media.filter((uri) => !uri.startsWith('https:'));
    expect(availableUris).toEqual([0, 1, 2].filter((segment) => segment !== missingSegment).map((segment) => `${segment}/qcamera.ts`));
    availableUris.forEach((uri) => {
      const data = readFileSync(resolve(assetRoot, uri));
      expect(data.length % 188).toBe(0); // MPEG-TS packet size
      expect(data[0]).toBe(0x47);
    });
  });

  it('uses its own first-frame event, coordinates and thumbnails through missing video', async () => {
    const { demo } = makeBackend();
    const routes = await demo.routes.getRoutesSegments(DEMO_DONGLE_ID);
    const route = routes[11];
    const events = JSON.parse(readAsset('0/events.json'));
    const firstFrame = events.find((event) => event.data.event_type === 'first_road_camera_frame');
    expect(firstFrame.route_offset_millis).toBe(0);
    const coords = [0, 1, 2].flatMap((segment) => JSON.parse(readAsset(`${segment}/coords.json`)));
    expect(coords.map((coord) => coord.t)).toEqual(Array.from({ length: 181 }, (_, time) => time));
    expect(coords[0]).toEqual({ t: 0, lat: route.start_lat, lng: route.start_lng });
    expect(coords[180]).toEqual({ t: 180, lat: route.end_lat, lng: route.end_lng });
    for (const segment of route.segment_numbers) {
      expect(demo.routeAssets.events(route, segment)).toBe(`${window.location.origin}/demo-video/${segment}/events.json`);
      expect(demo.routeAssets.coords(route, segment)).toBe(`${window.location.origin}/demo-video/${segment}/coords.json`);
      expect(demo.routeAssets.thumbnail(route, segment)).toBe(`${window.location.origin}/demo-video/${segment}/sprite.jpg`);
    }
  });

  it('keeps cached public data unmodified and passes real routes through', async () => {
    const { real, demo, route } = makeBackend();
    await demo.routes.getRoutesSegments(DEMO_DONGLE_ID);
    await demo.routes.getRoutesSegments(DEMO_DONGLE_ID);
    expect(real.routes.getRoutesSegments).toHaveBeenCalledTimes(1);
    expect(route.segment_numbers).toEqual([0, 1, 2, 3, 4]);
    expect(route.share_sig).toBe('signature');

    await demo.routes.getRoutesSegments('real-device', 1, 2, 3, 'real-device|route');
    expect(real.routes.getRoutesSegments).toHaveBeenLastCalledWith('real-device', 1, 2, 3, 'real-device|route');
    await demo.routes.getRouteFiles('real-device|route', true, { sig: 'test' });
    expect(real.routes.getRouteFiles).toHaveBeenLastCalledWith('real-device|route', true, { sig: 'test' });
    demo.video.getQcameraStreamUrl('real-device|route', 'exp', 'sig');
    expect(real.video.getQcameraStreamUrl).toHaveBeenLastCalledWith('real-device|route', 'exp', 'sig');
  });
});
