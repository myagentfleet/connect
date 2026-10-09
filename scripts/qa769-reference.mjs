/* Diagnostic reference only; no Connect application code or acceptance claims. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { webkit, devices } from 'playwright';

const execute = promisify(execFile);
const output = resolve(process.env.QA769_OUTPUT || 'qa769-reference-results');
const fixtures = resolve('public/demo-video');
const delay = (ms) => new Promise((accept) => setTimeout(accept, ms));
const report = {
  started: new Date().toISOString(), acceptanceRun: false, hostOS: process.platform,
  purpose: 'Separate all-200 fixture playback from Connect and from the RVFC renderer path in patched macOS WebKit.',
  controls: 'Original checked-in media bytes, Hls1.7.3, normal headed launch. Each arm and each seek target uses a fresh browser process. No screenshot is taken until after startup and the first paused seek are measured. Native uses iPhone13 emulation, not physical iOS or branded Safari.',
  order: ['no-rvfc-A1', 'rvfc-B1', 'rvfc-B2', 'no-rvfc-A2'],
  oracle: 'Startup/resume requires at least 2s without a seek or invalid state, >1.7s media-clock advancement, and increases in totalVideoFrames minus droppedVideoFrames both from the initial baseline and after a late baseline at1.5s. Paused seeks retain clock, quality counters and screenshots in both arms; RVFC frame timestamps are additionally checked only in the RVFC arm. Screenshots in the no-RVFC arm require visual review before any presented-frame claim.',
  rendererEvidence: [
    'https://github.com/microsoft/playwright/blob/v1.64.0/browser_patches/webkit/UPSTREAM_CONFIG.sh',
    'https://github.com/WebKit/WebKit/blob/56453fdfe0b0ca6258c23e6453b34f70b885d13f/Source/WebCore/platform/graphics/avfoundation/AudioVideoRendererAVFObjC.mm#L1503-L1537',
    'https://github.com/WebKit/WebKit/blob/56453fdfe0b0ca6258c23e6453b34f70b885d13f/Source/WebCore/platform/graphics/avfoundation/objc/MediaPlayerPrivateAVFoundationObjC.mm#L2761-L2807',
  ],
  cases: [],
};
const save = () => writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));

function observe(rvfc) {
  globalThis.qaEvents = []; globalThis.qaFrames = []; globalThis.qaPlayErrors = []; globalThis.qaHlsErrors = [];
  globalThis.qaProbe = null;
  const armed = new WeakSet();
  for (const type of ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'pause', 'seeking', 'seeked', 'waiting', 'ended', 'error', 'timeupdate']) {
    document.addEventListener(type, ({ target: video }) => {
      if (!(video instanceof HTMLVideoElement)) return;
      globalThis.qaEvents.push({ type, at: performance.now(), time: video.currentTime, paused: video.paused,
        seeking: video.seeking, ready: video.readyState, frames: video.getVideoPlaybackQuality().totalVideoFrames });
      if (rvfc && type === 'loadedmetadata' && !armed.has(video)) {
        armed.add(video);
        const frame = (at, metadata) => {
          globalThis.qaFrames.push({ at, mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames,
            expectedDisplayTime: metadata.expectedDisplayTime, currentTime: video.currentTime, paused: video.paused });
          video.requestVideoFrameCallback(frame);
        };
        video.requestVideoFrameCallback(frame);
      }
    }, true);
  }
}

const sample = (page) => page.locator('video').evaluate((video) => ({
  at: performance.now(), time: video.currentTime, duration: video.duration, paused: video.paused, seeking: video.seeking,
  ready: video.readyState, width: video.videoWidth, height: video.videoHeight,
  frames: video.getVideoPlaybackQuality().totalVideoFrames, droppedFrames: video.getVideoPlaybackQuality().droppedVideoFrames,
  lastFrame: globalThis.qaFrames.at(-1) || null,
  buffered: Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]),
  src: video.currentSrc, error: video.error && { code: video.error.code, message: video.error.message },
  callbackDeliveries: globalThis.qaFrames.length, visibility: document.visibilityState, focused: document.hasFocus(),
}));

async function sustained(page) {
  await page.evaluate(() => { globalThis.qaProbe = null; });
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    if (!video || video.paused || video.seeking || video.readyState < 2 || !video.videoWidth) {
      globalThis.qaProbe = null; return false;
    }
    const seeks = globalThis.qaEvents.filter(({ type }) => type === 'seeking').length;
    const at = performance.now(), time = video.currentTime, quality = video.getVideoPlaybackQuality();
    const frames = quality.totalVideoFrames - quality.droppedVideoFrames;
    const probe = globalThis.qaProbe;
    if (!probe || probe.seeks !== seeks) {
      globalThis.qaProbe = { seeks, at, time, frames }; return false;
    }
    if (!probe.late && at - probe.at >= 1500) probe.late = { at, time, frames };
    return at - probe.at >= 2000 && time > probe.time + 1.7 && frames > probe.frames
      && probe.late && at - probe.late.at >= 400 && time > probe.late.time + 0.3 && frames > probe.late.frames;
  }, null, { timeout: 15000 });
  return { baseline: await page.evaluate(() => globalThis.qaProbe), after: await sample(page) };
}

async function screenshot(page, result, phase) {
  const filename = `${result.name}-${phase}.png`;
  await page.screenshot({ path: resolve(output, filename), fullPage: true });
  result.screenshots.push(filename);
}

async function main() {
  assert.equal(process.platform, 'darwin', 'Native HLS comparison requires macOS');
  await mkdir(output, { recursive: true });
  report.sourceSha = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
  assert.equal(report.sourceSha, process.env.QA_CANDIDATE_SHA);
  await execute('git', ['diff', '--exit-code', report.sourceSha, '--', '.', ':!scripts/qa769-reference.mjs']);
  const hlsPackage = JSON.parse(await readFile('node_modules/hls.js/package.json', 'utf8'));
  assert.equal(hlsPackage.version, '1.7.3'); report.hlsVersion = hlsPackage.version;
  const files = new Map([['hls.js', await readFile('node_modules/hls.js/dist/hls.js')]]);
  for (const file of ['complete.m3u8', '0/qcamera.ts', '1/qcamera.ts', '2/qcamera.ts']) {
    files.set(file, await readFile(resolve(fixtures, file)));
  }
  report.sha256 = Object.fromEntries([...files].map(([file, bytes]) => [file, createHash('sha256').update(bytes).digest('hex')]));
  let active;
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname.slice(1);
    let bytes = files.get(path);
    let type = path.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : path.endsWith('.ts') ? 'video/mp2t' : 'text/javascript';
    if (path === '') {
      type = 'text/html';
      bytes = Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1"><title>Playback reference</title>
        <style>body{margin:16px;font:16px sans-serif;color:#ddd;background:#16181a}video{display:block;width:320px;height:200px;max-width:100%;background:black}p{max-width:640px}</style>
        </head><body><h1>Playback reference</h1><p>${active.name}</p><video controls playsinline muted preload="auto"></video>
        <p>Original media, every request available. No Connect application code.</p>
        ${active.transport === 'mse' ? '<script src="/hls.js"></script>' : ''}
        <script>
          const video = document.querySelector('video');
          video.addEventListener('loadedmetadata', () => { if (video.currentTime !== 0) video.currentTime = 0;
            video.play().catch(error => globalThis.qaPlayErrors.push({ name: error.name, message: error.message }));
          }, { once: true });
          ${active.transport === 'mse' ? `
            if (!Hls.isSupported()) throw new Error('Normal MSE support is required');
            const hls = new Hls({ autoStartLoad: false, maxBufferLength: 40 });
            hls.on(Hls.Events.MANIFEST_PARSED, () => hls.startLoad(0));
            hls.on(Hls.Events.ERROR, (_event, error) => globalThis.qaHlsErrors.push({ at: performance.now(), details: error.details, fatal: error.fatal }));
            hls.loadSource('/complete.m3u8'); hls.attachMedia(video);
          ` : "video.src = '/complete.m3u8'; video.load(); video.currentTime = 0;"}
        </script></body></html>`);
    }
    const entry = { path, at: Date.now(), method: req.method, range: req.headers.range || null, status: bytes ? 200 : 404 };
    active?.httpRequests.push(entry);
    res.once('close', () => { entry.completed = res.writableFinished; });
    if (!bytes) { res.writeHead(404); res.end('Not found'); return; }
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' };
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = Number(range[1]), end = Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1);
      if (start > end) { entry.status = 416; res.writeHead(416, { ...headers, 'Content-Range': `bytes */${bytes.length}` }); res.end(); return; }
      headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`;
      bytes = bytes.subarray(start, end + 1); entry.status = 206;
    }
    res.writeHead(entry.status, { ...headers, 'Content-Length': bytes.length });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  });
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const transport of ['mse', 'native']) for (const target of [75, 125]) for (const arm of report.order) {
      const rvfc = arm.startsWith('rvfc-');
      const result = { name: `${transport}-${arm}-target-${target}`, transport, rvfc, target, httpRequests: [], screenshots: [], pageErrors: [], observations: [] };
      report.cases.push(result); active = result;
      const browser = await webkit.launch({ headless: false });
      const context = await browser.newContext(transport === 'native' ? devices['iPhone 13'] : { viewport: { width: 1280, height: 800 } });
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      page.on('pageerror', (error) => result.pageErrors.push(error.message));
      try {
        await page.addInitScript(observe, rvfc);
        await page.goto(origin, { waitUntil: 'domcontentloaded' });
        report.browserVersion = browser.version();
        result.capabilities = await page.locator('video').evaluate((video) => ({ userAgent: navigator.userAgent,
          hls: video.canPlayType('application/vnd.apple.mpegurl'), mediaSource: typeof MediaSource,
          rvfc: typeof video.requestVideoFrameCallback, quality: typeof video.getVideoPlaybackQuality }));
        try { result.startup = { passed: true, ...await sustained(page) }; }
        catch (error) { result.startup = { passed: false, error: error.message, after: await sample(page) }; }
        await page.locator('video').evaluate((video) => video.pause());
        for (const requestedTime of [target]) {
          const observation = { requestedTime, before: await sample(page) }; result.observations.push(observation);
          await page.locator('video').evaluate((video, time) => { video.currentTime = time; }, requestedTime);
          try {
            await page.waitForFunction((target) => { const video = document.querySelector('video');
              return video.paused && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.3;
            }, requestedTime, { timeout: 10000 });
            observation.clockSettled = true;
          } catch (error) { observation.clockSettled = false; observation.clockError = error.message; }
          await delay(1000); observation.paused = await sample(page);
          observation.rvfcFrameMatches = rvfc ? Boolean(observation.paused.lastFrame
            && observation.paused.lastFrame.at > observation.before.at
            && Math.abs(observation.paused.lastFrame.mediaTime - requestedTime) < 0.6) : null;
          await screenshot(page, result, `paused-${requestedTime}`);
          await page.locator('video').evaluate((video) => { video.play().catch(error => globalThis.qaPlayErrors.push({ name: error.name, message: error.message })); });
          try { observation.resumed = { passed: true, ...await sustained(page) }; }
          catch (error) { observation.resumed = { passed: false, error: error.message, after: await sample(page) }; }
          await page.locator('video').evaluate((video) => video.pause());
          await screenshot(page, result, `resumed-${requestedTime}`);
        }
        result.finalMedia = await sample(page);
        assert.equal(result.finalMedia.src.startsWith('blob:'), transport === 'mse', 'The declared transport was used');
        if (transport === 'native') {
          assert.ok(result.capabilities.hls, 'The native profile supports HLS');
          assert.equal(result.finalMedia.src, `${origin}/complete.m3u8`);
        }
        assert.equal(result.httpRequests.some(({ path }) => path === 'hls.js'), transport === 'mse');
        for (const path of ['complete.m3u8', '0/qcamera.ts', `${Math.floor(target / 60)}/qcamera.ts`]) {
          assert.ok(result.httpRequests.some((request) => request.path === path), `The reference requests ${path}`);
        }
        assert.ok(result.httpRequests.filter(({ path }) => /\.m3u8$|\.ts$/.test(path)).every(({ status }) => status === 200 || status === 206));
        assert.deepEqual(result.pageErrors, []);
        result.complete = true;
      } catch (error) { result.complete = false; result.error = error.stack; }
      finally {
        Object.assign(result, await page.evaluate(() => ({ events: globalThis.qaEvents, frameMetadata: globalThis.qaFrames,
          playErrors: globalThis.qaPlayErrors, hlsErrors: globalThis.qaHlsErrors })).catch(() => ({})));
        await context.close(); await browser.close(); await save();
        console.log(JSON.stringify({ name: result.name, complete: result.complete, startup: result.startup?.passed,
          seeks: result.observations.map(({ requestedTime, clockSettled, rvfcFrameMatches, resumed }) => ({ requestedTime, clockSettled, rvfcFrameMatches, resumed: resumed?.passed })) }));
      }
    }
  } finally { await new Promise((accept) => server.close(accept)); }
  report.finished = new Date().toISOString();
  report.collectionComplete = report.cases.length === 16 && report.cases.every(({ complete }) => complete);
  report.startupPassed = report.cases.filter(({ startup }) => startup?.passed).length;
  report.failedClockObservations = report.cases.flatMap(({ observations }) => observations)
    .filter(({ clockSettled, resumed }) => !clockSettled || !resumed?.passed).length;
  await save();
  assert.ok(report.collectionComplete, 'Every predeclared reference arm must complete; playback failures remain recorded observations');
}

await main();
