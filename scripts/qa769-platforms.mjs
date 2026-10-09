/* Validation only. Publish on a separate QA branch, never in the application PR. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { firefox, webkit, devices } from 'playwright';
import { build, preview } from 'vite';

const execute = promisify(execFile);
const output = resolve(process.env.QA769_OUTPUT || 'qa769-platform-results');
const fixtures = resolve(process.env.QA769_FIXTURES || 'public/demo-video');
const engine = process.env.QA769_ENGINE || 'firefox';
const nativeProfile = process.env.QA769_NATIVE_PROFILE === 'true';
const traceCommands = process.env.QA769_TRACE_COMMANDS === 'true';
const buildOnly = process.env.QA769_BUILD_ONLY === 'true';
const existingDist = process.env.QA769_APP_DIST && resolve(process.env.QA769_APP_DIST);
const caseFilter = process.env.QA769_CASE || null;
const requestedCases = caseFilter?.split(',').map((name) => name.trim()).filter(Boolean);
const VIDEO = '.DriveView video';
const TIMELINE = '[role="slider"][aria-label="Drive timeline"]';
const OVERLAY = 'button[aria-label="Play video"],button[aria-label="Pause video"]';
const PUBLIC_ROUTE = '5beb9b58bd12b691|0000010a--a51155e496';
const PUBLIC_PREFIX = `/demo-video/${PUBLIC_ROUTE.replace('|', '/')}`;
const ids = { complete: 11, first: 12, middle: 13 };
const link = (kind) => `.DriveEntry[href="/deadbeefdeadbeef/00000000--${String(ids[kind]).padStart(10, '0')}"]`;
const report = {
  started: new Date().toISOString(), engine, nativeProfile, caseFilter, hostOS: process.platform,
  traceCommands, buildOnly, existingDist: existingDist || null,
  playbackVerification: 'Require 200ms without a seek or invalid playback state, media-clock advancement above 0.15s, and new decoded or presented frames after that baseline.',
  acceptanceRun: process.env.QA769_DIAGNOSTIC_ONLY !== 'true',
  scope: 'Production build, Playwright-patched browser engine, real media decoding and native media clock. Application cases use UI controls; the explicitly labeled plain-video reference uses scripted native media commands without application code.',
  profile: nativeProfile ? 'macOS WebKit with Playwright iPhone 13 emulation; requires native HLS. This is not physical iOS or branded Safari.' : 'Unmodified desktop browser capabilities; application selects its normal transport.',
  fixtures: 'Checked-in H.264/AAC MPEG-TS bytes. A local HTTP server supplies manifests, real 404 responses, repaired bytes and held requests, including byte ranges; only API metadata and map style are browser-intercepted.',
  omissions: ['Stock Firefox and branded Safari (Playwright uses patched engines)', 'Physical iOS/Android and installed PWAs',
    'Physical audio output, AAC audio-decoder proof, Bluetooth, background/foreground and OS media controls', 'Production map tiles and real driving footage'],
  cases: [], screenshots: [],
};
const delay = (ms) => new Promise((accept) => setTimeout(accept, ms));
const save = () => writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
async function eventually(predicate, message, timeout = 15000) {
  const until = Date.now() + timeout;
  while (!predicate() && Date.now() < until) await delay(100);
  assert.ok(predicate(), message);
}
const media = (page) => page.locator(VIDEO).evaluate((video) => ({
  id: video.dataset.qaVideo, time: video.currentTime, duration: video.duration,
  paused: video.paused, seeking: video.seeking, ready: video.readyState, rate: video.playbackRate, muted: video.muted,
  width: video.videoWidth, height: video.videoHeight, frames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
  presentedFrames: globalThis.qaFrames.get(video) ?? null,
  presentedFrame: globalThis.qaLastFrame.get(video) ?? null,
  timelineTime: Number(document.querySelector('[aria-label="Drive timeline"]')?.getAttribute('aria-valuenow')),
  loading: Boolean(document.querySelector('[aria-label="Loading video"]')),
  retryVisible: [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Retry'),
  currentSrc: video.currentSrc, transport: video.currentSrc.startsWith('blob:') ? 'MSE' : 'native URL',
  hlsModuleLoaded: performance.getEntriesByType('resource').some(({ name }) => /\/hls-[^/]+\.js/.test(name)),
  buffered: Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]),
  error: video.error && { code: video.error.code, message: video.error.message },
}));
const button = (page, name) => page.getByRole('button', { name, exact: true });
async function playing(page) {
  await page.waitForFunction((selector) => {
    const video = document.querySelector(selector);
    return video && !video.paused && !video.seeking && video.readyState >= 2 && video.videoWidth > 0;
  }, VIDEO);
  const before = await media(page);
  assert.ok(before.frames !== null || before.presentedFrames !== null, 'A real decoded/presented frame counter must be available');
  await page.evaluate(() => { globalThis.qaPlaybackProbe = null; });
  await page.waitForFunction((selector) => {
    const video = document.querySelector(selector);
    if (!video || video.paused || video.seeking || video.readyState < 2 || !video.videoWidth) {
      globalThis.qaPlaybackProbe = null;
      return false;
    }
    const id = video.dataset.qaVideo;
    const seeks = globalThis.qaEvents.filter((event) => event.id === id && event.type === 'seeking').length;
    const at = performance.now(), time = video.currentTime;
    const frames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? null;
    const presentedFrames = globalThis.qaFrames.get(video) ?? null;
    const probe = globalThis.qaPlaybackProbe;
    if (!probe || probe.id !== id || probe.seeks !== seeks) {
      globalThis.qaPlaybackProbe = { id, seeks, at, time, frames, presentedFrames };
      return false;
    }
    return at - probe.at >= 200 && time > probe.time + 0.15
      && ((frames !== null && probe.frames !== null && frames > probe.frames)
        || (presentedFrames !== null && probe.presentedFrames !== null && presentedFrames > probe.presentedFrames));
  }, VIDEO);
  if (nativeProfile) {
    const current = await media(page);
    assert.match(current.currentSrc, /^http:\/\/127\.0\.0\.1:.*\.m3u8$/, 'The emulated iPhone profile must actually use a native HLS URL');
    assert.equal(current.hlsModuleLoaded, false, 'The native profile must not load hls.js');
  }
}
async function pause(page) {
  if (await button(page, 'Pause').count()) await button(page, 'Pause').click();
  await page.waitForFunction((selector) => document.querySelector(selector)?.paused, VIDEO);
  await button(page, 'Play').waitFor();
}
async function speed(page, rate) {
  await button(page, 'Playback speed').click();
  await page.getByRole('menuitemradio', { name: `${rate}×`, exact: true }).click();
  await page.getByRole('menuitemradio').first().waitFor({ state: 'hidden' });
  await page.waitForFunction(({ selector, rate }) => document.querySelector(selector).playbackRate === rate, { selector: VIDEO, rate });
}
async function seek(page, seconds) {
  const slider = page.locator(TIMELINE);
  await slider.scrollIntoViewIfNeeded();
  const { box, min, max } = await slider.evaluate((element) => ({ box: element.getBoundingClientRect().toJSON(),
    min: Number(element.getAttribute('aria-valuemin')), max: Number(element.getAttribute('aria-valuemax')) }));
  const x = box.x + Math.max(0.5, Math.min(box.width - 0.5, box.width * (seconds - min) / (max - min)));
  await page.mouse.click(x, box.y + box.height / 2);
  return min + (x - box.x) / box.width * (max - min);
}
async function settledAt(page, target) {
  await page.waitForFunction(({ videoSelector, sliderSelector, target }) => {
    const video = document.querySelector(videoSelector);
    return video?.paused && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.8
      && Math.abs(Number(document.querySelector(sliderSelector).getAttribute('aria-valuenow')) - video.currentTime) < 0.25
      && !document.querySelector('[aria-label="Loading video"]')
      && ![...document.querySelectorAll('button')].some((element) => element.textContent.trim() === 'Retry');
  }, { videoSelector: VIDEO, sliderSelector: TIMELINE, target });
}
async function pausedFrameAt(page, target, previousFrameAt) {
  await settledAt(page, target);
  await page.waitForFunction(({ selector, target, previousFrameAt }) => {
    const frame = globalThis.qaLastFrame.get(document.querySelector(selector));
    return frame && frame.at > previousFrameAt && Math.abs(frame.mediaTime - target) < 0.6;
  }, { selector: VIDEO, target, previousFrameAt });
}
async function geometry(page, result, phase) {
  const state = await page.evaluate(() => {
    const bounds = (selector) => document.querySelector(selector)?.getBoundingClientRect().toJSON() || null;
    const main = document.querySelector('main');
    return { at: performance.now(), innerWidth, innerHeight, clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth, scrollX, scrollY,
      mainMarginLeft: main?.style.marginLeft || null, mainComputedMarginLeft: main && getComputedStyle(main).marginLeft,
      main: bounds('main'), drive: bounds('.DriveView'), video: bounds('.DriveView video'),
      timeline: bounds('[aria-label="Drive timeline"]'), controls: bounds('[aria-label="Playback controls"]') };
  });
  const entry = { phase, ...state };
  result.viewportGeometry ||= []; result.viewportGeometry.push(entry);
  console.log(`VIEWPORT_GEOMETRY ${JSON.stringify(entry)}`);
  return state;
}
async function errorVisible(page) {
  // hls.js retries fragments for approximately 31 seconds; native engines have their own network policy.
  await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some((element) =>
    /not uploaded|Unable to load video/.test(element.textContent)
      && [...element.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Retry')), null, { timeout: 60000 });
  assert.equal((await media(page)).paused, true, 'A terminal error pauses actual media');
}
async function capture(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => { window.scrollTo(0, 0); return new Promise((accept) => requestAnimationFrame(() => requestAnimationFrame(accept))); });
  const filename = `${name}-${page.viewportSize().width}.png`;
  await page.screenshot({ path: resolve(output, filename), fullPage: true });
  report.screenshots.push(filename);
}

async function main() {
  assert.ok(['firefox', 'webkit'].includes(engine), 'Choose a supported browser engine');
  assert.ok(!nativeProfile || (engine === 'webkit' && process.platform === 'darwin'), 'The native profile requires macOS WebKit');
  await mkdir(output, { recursive: true });
  report.sha = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
  report.expectedSha = process.env.QA_CANDIDATE_SHA;
  if (report.expectedSha) {
    assert.equal(report.sha, report.expectedSha, 'The exact candidate revision is checked out');
    await execute('git', ['diff', '--exit-code', report.expectedSha, '--', '.', ':!scripts/qa769-platforms.mjs', ':!.github/workflows/qa769-platforms.yaml']);
  }
  const assets = new Map();
  for (const segment of [0, 1, 2]) for (const name of ['qcamera.ts', 'coords.json', 'events.json', 'sprite.jpg']) {
    assets.set(`${segment}/${name}`, await readFile(resolve(fixtures, `${segment}/${name}`)));
  }
  for (const name of ['complete', 'missing-first', 'missing-middle']) assets.set(`${name}.m3u8`, await readFile(resolve(fixtures, `${name}.m3u8`)));
  report.fixtureSha256 = Object.fromEntries([...assets].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]));
  const sessions = new Map();
  let active;
  const contentType = (path) => path.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : path.endsWith('.ts') ? 'video/mp2t'
    : path.endsWith('.jpg') ? 'image/jpeg' : 'application/json';
  const respond = (req, res, bytes, status = 200, type = 'video/mp2t') => {
    if (res.destroyed || res.writableEnded) return;
    bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' };
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (status === 200 && range) {
      const start = Number(range[1]), end = Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1);
      if (start > end) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${bytes.length}` }); res.end(); return; }
      headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`;
      bytes = bytes.subarray(start, end + 1); status = 206;
    }
    res.writeHead(status, { ...headers, 'Content-Length': bytes.length }); res.end(req.method === 'HEAD' ? undefined : bytes);
  };
  const fixturePlugin = { name: 'qa-real-http-fixtures', configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/__qa-reference') {
        respond(req, res, `<!doctype html><html lang="en"><head><meta charset="utf-8">
          <meta name="viewport" content="width=device-width,initial-scale=1"><title>Native HLS reference</title>
          <style>body{margin:16px;font:16px sans-serif}video{display:block;width:100%;max-width:640px}</style></head>
          <body><h1>Plain native video reference</h1><p>macOS WebKit with iPhone emulation. No connect application code.</p>
          <main class="DriveView"><video controls playsinline muted preload="auto" src="/demo-video/missing-middle.m3u8"></video></main>
          </body></html>`, 200, 'text/html');
        return;
      }
      if (path.startsWith('/__qa/')) {
        const [, , sessionId, ...parts] = path.split('/');
        const session = sessions.get(sessionId), file = parts.join('/');
        if (!session || !assets.has(file.replace(/^missing-(first|middle)\.ts$/, (_, kind) => `${kind === 'first' ? 0 : 1}/qcamera.ts`))) {
          respond(req, res, 'Unknown QA media', 404, 'text/plain'); return;
        }
        const missing = /^missing-(first|middle)\.ts$/.exec(file)?.[1];
        const entry = { path, at: Date.now(), range: req.headers.range || null, missing: missing || null,
          repaired: Boolean(missing && session.healed.has(missing)), held: Boolean(missing && session.hold) };
        session.result.httpRequests.push(entry);
        res.once('close', () => { entry.finished = res.writableEnded; entry.status = res.statusCode; });
        if (missing && session.hold) { session.held.push({ req, res }); return; }
        const repaired = missing && session.healed.has(missing);
        const asset = missing ? `${missing === 'first' ? 0 : 1}/qcamera.ts` : file;
        respond(req, res, missing && !repaired ? 'BlobNotFound' : assets.get(asset), missing && !repaired ? 404 : 200,
          missing && !repaired ? 'text/plain' : contentType(asset));
        return;
      }
      if (!path.startsWith('/demo-video/')) { next(); return; }
      const file = path.startsWith(`${PUBLIC_PREFIX}/`) ? path.slice(PUBLIC_PREFIX.length + 1) : path.slice('/demo-video/'.length);
      if (!assets.has(file)) { respond(req, res, 'Unknown fixture', 404, 'text/plain'); return; }
      let bytes = assets.get(file);
      if (file.endsWith('.m3u8')) {
        assert.ok(active, 'A scenario owns each manifest request');
        if (active.failManifest) {
          active.result.httpRequests.push({ path, at: Date.now(), manifest: true, failedManifest: true, status: 404 });
          respond(req, res, 'BlobNotFound', 404, 'text/plain'); return;
        }
        const kind = file.startsWith('missing-first') ? 'first' : 'middle';
        bytes = bytes.toString().replace(/^https:.*$/gm, `/__qa/${active.id}/missing-${kind}.ts`)
          .replace(/^(\d+\/qcamera\.ts)$/gm, `/__qa/${active.id}/$1`);
        active.result.httpRequests.push({ path, at: Date.now(), manifest: true, body: bytes });
      }
      respond(req, res, bytes, 200, contentType(file));
    });
  } };
  const appDist = existingDist || resolve(output, 'app');
  if (!existingDist || buildOnly) {
    const transforms = [];
    const tracePlugin = { name: 'qa769-diagnostic-command-trace', enforce: 'pre', transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/src/components/DriveVideo/stream.js')) return;
      const entries = code.split('\n').filter((line) => /^export function openStream\(video, url, \{ onError, (?:onWaiting, )?onAudio, startPosition = 0 \}\) \{$/.test(line));
      assert.equal(entries.length, 1, 'The diagnostic hook matches one reviewed stream entry');
      const [entry] = entries;
      const errorHandler = 'hls.on(Hls.Events.ERROR, (_event, error) => {';
      assert.ok(code.includes(errorHandler), 'The diagnostic hook matches the existing HLS error listener');
      assert.equal(code.split('hls.startLoad(position)').length - 1, 2, 'Exactly two reviewed HLS loading calls are traced');
      const transformed = code.replace(entry, `${entry}\n  globalThis.qaCommandTrace?.push({ type: 'openStream', at: performance.now(), startPosition, url });`)
        .replaceAll('hls.startLoad(position)', "hls.startLoad((globalThis.qaCommandTrace?.push({ type: 'hls.startLoad', at: performance.now(), position }), position))")
        .replace(errorHandler, `${errorHandler} globalThis.qaHlsErrors?.push({ at: performance.now(), type: error.type, details: error.details, fatal: error.fatal, reason: error.reason });`);
      transforms.push({ file: 'src/components/DriveVideo/stream.js',
        originalSha256: createHash('sha256').update(code).digest('hex'),
        transformedSha256: createHash('sha256').update(transformed).digest('hex'),
        description: 'Diagnostic build only: record openStream/startLoad arguments and existing HLS error events; preserve return values, loading commands and error handling.' });
      return { code: transformed, map: null };
    } };
    await build({ mode: 'production', plugins: traceCommands ? [tracePlugin] : [], build: { outDir: appDist, sourcemap: false } });
    if (traceCommands) assert.equal(transforms.length, 1, 'The intended stream module was instrumented exactly once');
    report.diagnosticBuildTransforms = transforms;
    await writeFile(resolve(appDist, 'qa769-build-provenance.json'), JSON.stringify({ sha: report.sha, traceCommands, transforms }, null, 2));
  }
  if (existingDist) {
    report.buildProvenance = JSON.parse(await readFile(resolve(appDist, 'qa769-build-provenance.json'), 'utf8'));
    assert.equal(report.buildProvenance.sha, report.sha, 'The reused build belongs to this exact application revision');
    assert.equal(report.buildProvenance.traceCommands, traceCommands, 'The reused build has the declared diagnostic instrumentation');
  }
  if (buildOnly) { report.finished = new Date().toISOString(); report.built = true; await save(); return; }
  const server = await preview({ configFile: false, plugins: [fixturePlugin], build: { outDir: appDist },
    preview: { host: '127.0.0.1', port: 0, strictPort: true } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  let browser;
  try {
    // Standard Playwright launch; no browser security flags or media capability overrides.
    browser = await ({ firefox, webkit }[engine]).launch({ headless: false });
    report.browserVersion = browser.version();
    async function scenario(name, run, { diagnostic = false, reference = false } = {}) {
      if (requestedCases && !requestedCases.includes(name)) return;
      const context = await browser.newContext({ ...(nativeProfile ? devices['iPhone 13'] : { viewport: { width: 1280, height: 800 } }),
        timezoneId: 'America/Los_Angeles', serviceWorkers: 'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(20000);
      const result = { name, status: 'running', diagnostic, reference, pageErrors: [], console: [], requestFailures: [], httpRequests: [] };
      const session = { id: String(report.cases.length + 1), result, healed: new Set(), held: [], hold: false };
      sessions.set(session.id, session); active = session; report.cases.push(result);
      page.on('pageerror', (error) => result.pageErrors.push(error.message));
      page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) result.console.push(message.text()); });
      page.on('requestfailed', (request) => result.requestFailures.push({ url: request.url(), failure: request.failure() }));
      try {
        await page.addInitScript((traceCommands) => {
          performance.setResourceTimingBufferSize(3000);
          globalThis.qaEvents = []; globalThis.qaFrames = new WeakMap();
          globalThis.qaLastFrame = new WeakMap(); globalThis.qaFrameMetadata = []; let nextId = 0;
          globalThis.qaCommandTrace = []; globalThis.qaLifecycle = []; globalThis.qaHlsErrors = [];
          if (traceCommands) {
            const record = (video, type, value) => {
              video.dataset.qaVideo ||= String(++nextId);
              globalThis.qaCommandTrace.push({ type, value, id: video.dataset.qaVideo, at: performance.now(), stack: new Error().stack });
            };
            for (const method of ['play', 'pause', 'load']) {
              const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, method);
              Object.defineProperty(HTMLMediaElement.prototype, method, { ...descriptor, value: function (...args) {
                record(this, `video.${method}`, args);
                return Reflect.apply(descriptor.value, this, args);
              } });
            }
            for (const property of ['currentTime', 'playbackRate', 'muted', 'src']) {
              const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, property);
              Object.defineProperty(HTMLMediaElement.prototype, property, { ...descriptor, set(value) {
                record(this, `video.${property}=`, value);
                return Reflect.apply(descriptor.set, this, [value]);
              } });
            }
            const lifecycle = (event) => globalThis.qaLifecycle.push({ type: event?.type || 'init', at: performance.now(),
              visibility: document.visibilityState, focused: document.hasFocus(), width: innerWidth, height: innerHeight });
            document.addEventListener('visibilitychange', lifecycle);
            window.addEventListener('focus', lifecycle); window.addEventListener('blur', lifecycle); lifecycle();
          }
          const observers = new WeakMap();
          const stopFrames = (video) => {
            const observer = observers.get(video);
            if (!observer) return;
            observer.cancelled = true;
            if (observer.handle !== null) video.cancelVideoFrameCallback(observer.handle);
            observer.handle = null;
          };
          const startFrames = (video) => {
            if (!video.requestVideoFrameCallback) return;
            stopFrames(video);
            const observer = { generation: (observers.get(video)?.generation || 0) + 1, cancelled: false, handle: null };
            observers.set(video, observer);
            const frame = (at, metadata) => {
              if (observer.cancelled) return;
              globalThis.qaFrames.set(video, (globalThis.qaFrames.get(video) || 0) + 1);
              const sample = { id: video.dataset.qaVideo, generation: observer.generation, at, mediaTime: metadata.mediaTime,
                presentedFrames: metadata.presentedFrames, expectedDisplayTime: metadata.expectedDisplayTime,
                currentTime: video.currentTime, paused: video.paused };
              globalThis.qaLastFrame.set(video, sample); globalThis.qaFrameMetadata.push(sample);
              if (globalThis.qaFrameMetadata.length > 3000) globalThis.qaFrameMetadata.shift();
              observer.handle = video.isConnected ? video.requestVideoFrameCallback(frame) : null;
            };
            observer.handle = video.requestVideoFrameCallback(frame);
          };
          for (const type of ['loadedmetadata', 'playing', 'pause', 'seeking', 'seeked', 'waiting', 'ended', 'error', 'emptied', 'ratechange', 'timeupdate']) {
            document.addEventListener(type, ({ target }) => {
              if (!(target instanceof HTMLVideoElement)) return;
              target.dataset.qaVideo ||= String(++nextId);
              if (type === 'emptied') {
                stopFrames(target); globalThis.qaLastFrame.delete(target);
                if (target.requestVideoFrameCallback) globalThis.qaFrames.set(target, 0);
              }
              // Native load() can invalidate a callback queued before metadata. Re-arm for each real source load.
              if (type === 'loadedmetadata') startFrames(target);
              globalThis.qaEvents.push({ type, id: target.dataset.qaVideo, at: performance.now(), time: target.currentTime,
                paused: target.paused, ready: target.readyState, rate: target.playbackRate });
              if (globalThis.qaEvents.length > 3000) globalThis.qaEvents.shift();
            }, true);
          }
        }, traceCommands);
        const start = Date.parse('2026-10-09T12:00:00Z');
        const publicRoute = { fullname: PUBLIC_ROUTE, dongle_id: PUBLIC_ROUTE.split('|')[0], url: `${origin}/demo-video`,
          create_time: start / 1000, start_time: new Date(start).toISOString().slice(0, 19), end_time: new Date(start + 180000).toISOString().slice(0, 19),
          start_time_utc_millis: start, end_time_utc_millis: start + 180000, segment_numbers: [0, 1, 2],
          segment_start_times: [0, 1, 2].map((i) => start + i * 60000), segment_end_times: [1, 2, 3].map((i) => start + i * 60000),
          maxqlog: 2, procqlog: 2, distance: 0.105, is_public: true, start_lat: 32.75, start_lng: -117.195,
          end_lat: 32.75, end_lng: -117.1932, videoStartOffset: 0,
          startLocation: { place: 'Synthetic start', details: 'QA fixture' }, endLocation: { place: 'Synthetic end', details: 'QA fixture' } };
        await context.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          const fulfill = (body, status = 200) => route.fulfill({ status, contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'Access-Control-Allow-Headers': 'Content-Type' },
            body: typeof body === 'string' ? body : JSON.stringify(body) });
          if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
          if (route.request().method() === 'OPTIONS') return fulfill('', 204);
          if (url.hostname === 'api.comma.ai' && url.pathname === '/v1/devices/5beb9b58bd12b691/routes_segments') return fulfill([publicRoute]);
          if (url.hostname === 'api.comma.ai' && decodeURIComponent(url.pathname) === `/v1/route/${PUBLIC_ROUTE}/files`) {
            return fulfill({ qcameras: [0, 1, 2].map((segment) => `${origin}${PUBLIC_PREFIX}/${segment}/qcamera.ts`) });
          }
          if (url.hostname === 'api.mapbox.com' && url.pathname.startsWith('/styles/v1/')) return fulfill({ version: 8, sources: {},
            layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#202c33' } }] });
          if (url.hostname === 'api.mapbox.com' && url.pathname.startsWith('/geocoding/')) return fulfill({ features: [] });
          if (url.hostname.endsWith('mapbox.com')) return fulfill('', 204);
          result.console.push(`Blocked external request: ${url.origin}${url.pathname}`); return route.abort('blockedbyclient');
        });
        await page.goto(`${origin}/${reference ? '__qa-reference' : 'demo'}`, { waitUntil: 'domcontentloaded' });
        await page.locator(reference ? VIDEO : link('complete')).waitFor();
        result.capabilities = await page.evaluate(() => {
          const video = document.createElement('video');
          return { userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints,
            canPlayHls: video.canPlayType('application/vnd.apple.mpegurl'), h264Aac: video.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'),
            mediaSource: typeof MediaSource, mseH264Aac: globalThis.MediaSource?.isTypeSupported('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') ?? false,
            videoFrameCallback: typeof video.requestVideoFrameCallback, videoPlaybackQuality: typeof video.getVideoPlaybackQuality,
            hover: matchMedia('(hover: hover)').matches, finePointer: matchMedia('(pointer: fine)').matches };
        });
        console.log(`CAPABILITIES ${name} ${JSON.stringify(result.capabilities)}`);
        if (nativeProfile) assert.ok(result.capabilities.canPlayHls, 'Native HLS must be supported in the labeled native profile');
        const openRoute = async (kind) => {
          if (await page.locator('.DriveView').count()) await page.locator('.DriveView [aria-label="Close"]').click();
          await page.locator(link(kind)).click(); await page.locator(VIDEO).waitFor();
        };
        await run({ page, result, session, openRoute });
        assert.deepEqual(result.pageErrors, [], 'No uncaught application errors');
        result.status = diagnostic ? 'observed' : 'passed';
      } catch (error) {
        result.status = 'failed'; result.error = error.stack;
        await capture(page, `${name}-failure`).catch((error) => { result.screenshotError = error.message; });
      } finally {
        result.mediaEvents = await page.evaluate(() => globalThis.qaEvents).catch(() => []);
        result.frameMetadata = await page.evaluate(() => globalThis.qaFrameMetadata).catch(() => []);
        if (traceCommands) {
          result.commandTrace = await page.evaluate(() => globalThis.qaCommandTrace).catch(() => []);
          result.hlsErrors = await page.evaluate(() => globalThis.qaHlsErrors).catch(() => []);
          result.pageLifecycle = await page.evaluate(() => globalThis.qaLifecycle).catch(() => []);
          result.finalPageState = await page.evaluate(() => ({ visibility: document.visibilityState, focused: document.hasFocus() })).catch(() => null);
        }
        result.finalMedia = await media(page).catch(() => null);
        result.finalText = await page.locator('body').innerText().catch(() => '');
        for (const { req, res } of session.held) respond(req, res, 'BlobNotFound', 404, 'text/plain');
        await context.close();
        console.log(`${result.status.toUpperCase()}: ${name}${result.error ? `\n${result.error}` : ''}`);
        await save();
      }
    }
    await scenario('controls-and-decoded-playback', async ({ page, result, openRoute }) => {
      await openRoute('complete'); await playing(page); await pause(page);
      const stopped = await media(page); await delay(400);
      assert.ok(Math.abs((await media(page)).time - stopped.time) < 0.05, 'Pause stops the actual clock');
      await settledAt(page, await seek(page, 45));
      await page.locator(TIMELINE).focus(); await page.keyboard.press('ArrowRight'); await settledAt(page, 55);
      await button(page, 'Jump back 10 seconds').click(); await settledAt(page, 45);
      const rate = nativeProfile ? 2 : 4;
      await speed(page, rate); assert.equal((await media(page)).paused, true, 'Changing speed preserves paused state');
      await button(page, 'Unmute').click(); assert.equal((await media(page)).muted, false, 'Unmute changes actual media state');
      await button(page, 'Play video').click(); await playing(page);
      assert.equal((await media(page)).rate, rate, 'Playback retains selected speed');
      await button(page, 'Mute').click(); assert.equal((await media(page)).muted, true, 'Mute changes actual media state');
      const before = await media(page);
      await button(page, 'Map').click(); await playing(page);
      assert.equal((await media(page)).id, before.id, 'Playing Map view preserves the actual media element');
      assert.equal(await page.locator(OVERLAY).count(), 0, 'Map view removes the video overlay');
      await page.locator('.mapboxgl-canvas').waitFor({ state: 'visible' });
      await capture(page, 'playing-map');
      await button(page, 'Video').click(); await playing(page);
      assert.equal((await media(page)).id, before.id, 'Returning to Video preserves actual media');
      await button(page, 'Pause video').click(); await pause(page);
      result.decodedMedia = await media(page);
      for (const width of nativeProfile ? [390] : [1280, 390]) {
        await page.setViewportSize({ width, height: width < 600 ? 844 : 800 });
        await geometry(page, result, 'immediately-after-resize');
        // The existing window-size subscription debounces for 150ms. Observe its resulting layout, not its transition.
        await delay(200);
        await page.waitForFunction(() => {
          const selectors = ['.DriveView', '.DriveView video', '[aria-label="Playback controls"]'];
          return document.documentElement.scrollWidth <= innerWidth + 1 && selectors.every((selector) => {
            const box = document.querySelector(selector)?.getBoundingClientRect();
            return box && box.width > 0 && box.left >= -1 && box.right <= innerWidth + 1;
          });
        });
        await geometry(page, result, 'before-screenshot');
        await capture(page, 'paused-player');
        await geometry(page, result, 'after-screenshot');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'The player fits the viewport');
      }
    });
    await scenario('healthy-loop', async ({ page, result, openRoute }) => {
      await openRoute('complete'); await playing(page); await pause(page);
      const slider = page.locator(TIMELINE); await slider.scrollIntoViewIfNeeded();
      const box = await slider.boundingBox();
      await page.mouse.move(box.x + box.width / 180, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width * 15 / 180, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
      await page.waitForFunction((selector) => Number(document.querySelector(selector).getAttribute('aria-valuemax')) < 16, TIMELINE);
      const bounds = await slider.evaluate((element) => ({ start: Number(element.getAttribute('aria-valuemin')), end: Number(element.getAttribute('aria-valuemax')) }));
      assert.ok(bounds.start > 0 && bounds.start < 2 && bounds.end > 14, 'Pointer drag creates the intended loop');
      await speed(page, nativeProfile ? 2 : 8);
      const eventStart = await page.evaluate(() => globalThis.qaEvents.length);
      await button(page, 'Play').click(); await playing(page); await delay(nativeProfile ? 8500 : 3000); await pause(page);
      const times = await page.evaluate((start) => globalThis.qaEvents.slice(start).filter(({ type }) => type === 'timeupdate').map(({ time }) => time), eventStart);
      assert.ok(times.some((time, index) => index && times[index - 1] - time > 5), 'The actual media clock wraps the loop');
      assert.ok(times.every((time) => time >= bounds.start - 0.8 && time <= bounds.end + 0.8), 'Actual loop samples stay in the selected interval');
      assert.equal(await button(page, 'Retry').count(), 0, 'Healthy loop does not show an error');
      result.loop = { bounds, times }; await capture(page, 'healthy-loop');
    });
    await scenario('missing-first-and-repair', async ({ page, result, session, openRoute }) => {
      await openRoute('first'); await errorVisible(page);
      assert.ok(result.httpRequests.some(({ missing, status }) => missing === 'first' && status === 404), 'The server actually delivered a missing-first HTTP 404');
      assert.equal(await page.locator(OVERLAY).count(), 0, 'The fatal error replaces the overlay');
      await capture(page, 'missing-first'); await pause(page);
      await settledAt(page, await seek(page, 125));
      await page.locator(TIMELINE).focus(); await page.keyboard.press('Home'); await errorVisible(page);
      const requests = result.httpRequests.length; session.healed.add('first');
      await button(page, 'Retry').click(); await settledAt(page, 0);
      assert.ok(result.httpRequests.slice(requests).some(({ missing, repaired }) => missing === 'first' && repaired), 'Retry fetches actual repaired bytes');
      await button(page, 'Play').click(); await playing(page); await capture(page, 'first-repaired');
    });
    await scenario('missing-middle-retry-and-later-recovery', async ({ page, result, openRoute }) => {
      await openRoute('middle'); await playing(page); await pause(page);
      await seek(page, 75); await errorVisible(page); await capture(page, 'missing-middle');
      const count = result.httpRequests.filter(({ missing }) => missing === 'middle').length;
      await button(page, 'Retry').click();
      await eventually(() => result.httpRequests.filter(({ missing }) => missing === 'middle').length > count, 'Retry issues a real request for the missing middle fragment');
      await errorVisible(page); await settledAt(page, await seek(page, 125));
      await button(page, 'Play').click(); await playing(page); await capture(page, 'middle-recovered');
    });
    await scenario('loading-and-navigation-cancellation', async ({ page, result, session, openRoute }) => {
      session.hold = true; await openRoute('first');
      await eventually(() => session.held.length, 'The server holds an actual first-fragment request');
      await page.getByLabel('Loading video', { exact: true }).waitFor();
      const overlay = await button(page, 'Pause video').elementHandle();
      const before = await media(page);
      await overlay.focus(); await page.keyboard.press('Enter'); await button(page, 'Play video').waitFor();
      assert.equal((await media(page)).paused, true, 'Keyboard pause works while waiting');
      await page.keyboard.press('Space'); await button(page, 'Pause video').waitFor();
      assert.ok(await overlay.evaluate((element) => element.isConnected && document.activeElement === element), 'Loading transport retains keyboard focus');
      const after = await media(page);
      assert.equal(after.frames ?? after.presentedFrames, 0, 'A command before the first fragment is not decoded playback');
      assert.ok(Math.abs(after.time - before.time) < 0.05, 'Waiting commands do not advance the clock');
      result.loadingMedia = { before, after }; await capture(page, 'loading');
      const old = await page.locator(VIDEO).elementHandle();
      session.hold = false; await openRoute('complete'); await playing(page);
      assert.equal(await old.evaluate((element) => element.isConnected), false, 'Navigation disconnects the old video');
      const good = await media(page);
      for (const { req, res } of session.held.splice(0)) respond(req, res, 'BlobNotFound', 404, 'text/plain');
      await playing(page);
      assert.equal((await media(page)).id, good.id, 'Old HTTP work does not replace the new media');
      assert.equal(await button(page, 'Retry').count(), 0, 'Old failure does not appear on the new route');
      await capture(page, 'navigation-recovered');
    });
    if (nativeProfile) {
      await scenario('native-gap-observations', async ({ page, result, session, openRoute }) => {
        result.acceptance = 'Not an acceptance pass: records native gap behavior, including stale frames at the missing middle. Valid later/repaired frames are checked independently.';
        result.observations = {};
        await openRoute('first'); await playing(page);
        assert.ok(result.httpRequests.some(({ missing, status }) => missing === 'first' && status === 404), 'Native startup really encounters the first-fragment 404');
        await page.waitForFunction((selector) => document.querySelector(selector).currentTime >= 60, VIDEO);
        await pause(page);
        await page.waitForFunction(({ video, timeline }) => Math.abs(document.querySelector(video).currentTime
          - Number(document.querySelector(timeline).getAttribute('aria-valuenow'))) < 0.25, { video: VIDEO, timeline: TIMELINE });
        result.observations.firstGapSkip = await media(page);
        assert.ok(result.observations.firstGapSkip.presentedFrame?.mediaTime >= 60, 'Automatic skipping presents a real frame after the first gap');
        await capture(page, 'native-first-automatic-skip');

        await openRoute('middle'); await playing(page); await pause(page);
        const target = await seek(page, 75);
        await eventually(() => result.httpRequests.some(({ missing, status }) => missing === 'middle' && status === 404), 'Native middle gap really returns HTTP 404');
        result.observations.middleRequestedTime = target;
        result.observations.middlePausedSamples = [];
        for (let sample = 0; sample < 6; sample += 1) {
          result.observations.middlePausedSamples.push(await media(page));
          if (sample < 5) await delay(200);
        }
        result.observations.middlePaused = await media(page);
        result.observations.middlePaused.stalePresentedFrame = result.observations.middlePaused.presentedFrame
          ? Math.abs(result.observations.middlePaused.presentedFrame.mediaTime - target) > 0.6 : null;
        await capture(page, 'native-middle-paused-observation');
        await button(page, 'Play').click();
        result.observations.middleResumedSamples = [];
        for (let sample = 0; sample < 10; sample += 1) {
          await delay(200); result.observations.middleResumedSamples.push(await media(page));
        }
        result.observations.middleResumed = await media(page);
        await capture(page, 'native-middle-resumed-observation'); await pause(page);

        const previous = (await media(page)).presentedFrame?.at ?? -1;
        await pausedFrameAt(page, await seek(page, 125), previous);
        result.observations.laterPaused = await media(page);
        await button(page, 'Play').click(); await playing(page); await pause(page);
        await capture(page, 'native-valid-later-frame');

        const requestCount = result.httpRequests.length; session.healed.add('middle');
        await openRoute('middle'); await playing(page); await pause(page);
        const priorRepairFrame = (await media(page)).presentedFrame?.at ?? -1;
        await pausedFrameAt(page, await seek(page, 75), priorRepairFrame);
        assert.ok(result.httpRequests.slice(requestCount).some(({ missing, repaired, status }) => missing === 'middle' && repaired && status === 200),
          'Reopening after repair requests actual missing-middle bytes');
        result.observations.repairedPaused = await media(page);
        await button(page, 'Play').click(); await playing(page); await pause(page);
        await capture(page, 'native-repaired-middle-frame');
        console.log(`NATIVE_GAP_OBSERVATIONS ${JSON.stringify(result.observations)}`);
      }, { diagnostic: true });
      await scenario('native-manifest-error-and-repaired-retry', async ({ page, result, session, openRoute }) => {
        session.failManifest = true;
        await openRoute('complete'); await errorVisible(page);
        assert.ok(result.httpRequests.some(({ failedManifest, status }) => failedManifest && status === 404), 'A real missing manifest causes the terminal native error');
        assert.equal(await page.locator(OVERLAY).count(), 0, 'Fatal native error replaces the video overlay');
        await capture(page, 'native-manifest-error'); await pause(page);
        const count = result.httpRequests.length; session.failManifest = false;
        await button(page, 'Retry').click(); await settledAt(page, 0);
        assert.ok(result.httpRequests.slice(count).some(({ manifest, failedManifest }) => manifest && !failedManifest), 'Retry really refetches the repaired manifest');
        await button(page, 'Play').click(); await playing(page); await pause(page);
        result.repairedMedia = await media(page); await capture(page, 'native-manifest-repaired');
      });
      await scenario('native-plain-video-reference', async ({ page, result }) => {
        result.acceptance = 'Reference observation only, not an application acceptance pass. Commands call the unmodified HTMLMediaElement directly.';
        assert.equal(await page.locator('script').count(), 0, 'The reference page contains no application scripts');
        assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some(({ name }) => /\/assets\/.*\.js/.test(name))), false,
          'No application bundle was loaded in the reference document');
        await page.locator(VIDEO).evaluate((video) => video.play()); await playing(page);
        await eventually(() => result.httpRequests.some(({ missing, status }) => missing === 'middle' && status === 404),
          'The reference engine receives the same real missing-middle 404');
        await page.locator(VIDEO).evaluate((video) => video.pause());
        result.referenceInitial = await media(page); result.referenceObservations = [];
        for (const target of [75, 125]) {
          const observation = { requestedTime: target, pausedSamples: [], playingSamples: [] };
          result.referenceObservations.push(observation);
          observation.seekCommand = await page.locator(VIDEO).evaluate((video, target) => {
            video.pause();
            try {
              video.currentTime = target;
              return { requestedTime: target, immediateTime: video.currentTime, seeking: video.seeking };
            } catch (error) { return { requestedTime: target, error: { name: error.name, message: error.message } }; }
          }, target);
          for (let sample = 0; sample < 6; sample += 1) {
            observation.pausedSamples.push(await media(page));
            if (sample < 5) await delay(200);
          }
          await capture(page, `reference-paused-${target}`);
          observation.playCommand = await page.locator(VIDEO).evaluate(async (video) => {
            let timeout;
            try {
              return await Promise.race([
                video.play().then(() => ({ resolved: true }), (error) => ({ error: { name: error.name, message: error.message } })),
                new Promise((accept) => { timeout = setTimeout(() => accept({ pendingAfterMs: 2000 }), 2000); }),
              ]);
            } catch (error) { return { error: { name: error.name, message: error.message } }; }
            finally { clearTimeout(timeout); }
          });
          for (let sample = 0; sample < 10; sample += 1) {
            await delay(200); observation.playingSamples.push(await media(page));
          }
          await capture(page, `reference-playing-${target}`);
          await page.locator(VIDEO).evaluate((video) => video.pause());
          console.log(`NATIVE_REFERENCE_OBSERVATION ${JSON.stringify(observation)}`);
        }
      }, { diagnostic: true, reference: true });
      await scenario('app-native-repaired-middle-frame', async ({ page, result, session, openRoute }) => {
        session.healed.add('middle'); await openRoute('middle'); await playing(page); await pause(page);
        assert.ok(result.httpRequests.some(({ missing, repaired, status }) => missing === 'middle' && repaired && status === 200),
          'The app actually loads the repaired middle-fragment bytes');
        result.repairedSeeks = [];
        for (const requestedTime of [75, 125]) {
          const previousFrameAt = (await media(page)).presentedFrame?.at ?? -1;
          const target = await seek(page, requestedTime);
          await pausedFrameAt(page, target, previousFrameAt);
          result.repairedSeeks.push({ requestedTime, target, media: await media(page) });
          await capture(page, `app-native-repaired-frame-${requestedTime}`);
          await button(page, 'Play').click(); await playing(page); await pause(page);
        }
      });
    }
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
  assert.ok(report.cases.length, 'At least one requested scenario ran');
  if (requestedCases) assert.deepEqual(report.cases.map(({ name }) => name).sort(), [...requestedCases].sort(), 'Every requested diagnostic scenario ran');
  report.finished = new Date().toISOString(); report.passed = report.cases.every(({ status, diagnostic }) => status === 'passed' || (diagnostic && status === 'observed'));
  await save(); assert.ok(report.passed, 'One or more platform scenarios failed; inspect report and screenshots');
}
main().catch(async (error) => {
  report.fatalError = error.stack; report.passed = false;
  await mkdir(output, { recursive: true }); await save(); console.error(error); process.exitCode = 1;
});
