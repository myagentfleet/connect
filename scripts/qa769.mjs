/* Validation only: copy to scripts/qa769.mjs on qa/769-playback, never the fix PR. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { build, preview } from 'vite';

const execute = promisify(execFile);
const output = resolve(process.env.QA769_OUTPUT || 'qa769-results');
const VIDEO = 'video[aria-label="Drive video"]';
const TIMELINE = '[role="slider"][aria-label="Drive timeline"]';
const PUBLIC_ROUTE = '5beb9b58bd12b691|0000010a--a51155e496';
const routes = { complete: 11, first: 12, middle: 13 };
const viewports = [320, 390, 1280, 1600].map((width) => ({ width, height: width < 600 ? 844 : 800, deviceScaleFactor: 1 }));
const report = {
  started: new Date().toISOString(), cases: [], layouts: [], screenshots: [],
  scope: 'Production build, real Google Chrome, native media events, checked-in H.264/AAC MPEG-TS fixtures, UI-only playback commands. The explicitly labeled MSE scenario overrides only HLS capability discovery to exercise hls.js.',
  fixtures: 'Public-route metadata is deterministic; exact missing fragment URLs receive HTTP 404 via request interception, or real TS bytes after repair. Mapbox style is a plain deterministic background; the production WebGL route and marker render normally.',
  omissions: ['Native Safari/iOS/Android and installed PWAs', 'Physical audio output, Bluetooth, background/foreground and OS media controls', 'Production map tiles and real driving footage', 'Deterministically delayed native play promise rejection (covered separately by unit tests)'],
};
const delay = (ms) => new Promise((accept) => setTimeout(accept, ms));
async function eventually(predicate, message) {
  const deadline = Date.now() + 15000;
  while (!predicate() && Date.now() < deadline) await delay(100);
  assert.ok(predicate(), message);
}
const logId = (kind) => `00000000--${String(routes[kind]).padStart(10, '0')}`;
const routeLink = (kind) => `.DriveEntry[href="/deadbeefdeadbeef/${logId(kind)}"]`;
const media = (page) => page.$eval(VIDEO, (video) => ({
  id: video.dataset.qaVideo, time: video.currentTime, paused: video.paused, seeking: video.seeking,
  ready: video.readyState, rate: video.playbackRate, muted: video.muted,
  videoWidth: video.videoWidth, videoHeight: video.videoHeight,
  frames: video.getVideoPlaybackQuality?.().totalVideoFrames || 0,
  audioBytes: video.webkitAudioDecodedByteCount || 0,
  currentSrc: video.currentSrc, canPlayHls: video.canPlayType('application/vnd.apple.mpegurl'),
  originalCanPlayHls: globalThis.qaOriginalCanPlayHls,
  hlsModuleLoaded: performance.getEntriesByType('resource').some(({ name }) => /\/hls-[^/]+\.js/.test(name)),
  buffered: Array.from({ length: video.buffered.length }, (_, index) => [video.buffered.start(index), video.buffered.end(index)]),
  error: video.error && { code: video.error.code, message: video.error.message },
}));

async function click(page, selector) {
  const element = await page.waitForSelector(selector, { visible: true });
  await element.click();
}

async function textButton(page, text) {
  const button = await page.waitForFunction((value) => [...document.querySelectorAll('button')]
    .find((element) => element.textContent.trim() === value && element.getClientRects().length), {}, text);
  await button.asElement().click();
}

async function playing(page) {
  await page.waitForFunction((selector) => {
    const video = document.querySelector(selector);
    return video && !video.paused && !video.seeking && video.readyState >= 2 && video.videoWidth > 0;
  }, {}, VIDEO);
  const before = await media(page);
  await page.waitForFunction(({ selector, time, frames }) => {
    const video = document.querySelector(selector);
    return video.currentTime > time + 0.15 && (video.getVideoPlaybackQuality?.().totalVideoFrames || 0) > frames;
  }, {}, { selector: VIDEO, time: before.time, frames: before.frames });
}

async function pause(page) {
  if (await page.$('button[aria-label="Pause"]')) await click(page, 'button[aria-label="Pause"]');
  await page.waitForFunction((selector) => document.querySelector(selector)?.paused, {}, VIDEO);
  await page.waitForSelector('button[aria-label="Unpause"]');
}

async function seek(page, seconds) {
  const slider = await page.waitForSelector(TIMELINE, { visible: true });
  await slider.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  const { box, min, max } = await slider.evaluate((element) => ({
    box: element.getBoundingClientRect().toJSON(),
    min: Number(element.getAttribute('aria-valuemin')), max: Number(element.getAttribute('aria-valuemax')),
  }));
  const x = box.x + Math.max(0.5, Math.min(box.width - 0.5, box.width * (seconds - min) / (max - min)));
  await page.mouse.click(x, box.y + box.height / 2);
  return min + (x - box.x) / box.width * (max - min);
}

async function settledAt(page, seconds, paused = true) {
  await page.waitForFunction(({ videoSelector, timelineSelector, target, expectedPause }) => {
    const video = document.querySelector(videoSelector);
    const timeline = document.querySelector(timelineSelector);
    return video && video.readyState >= 2 && !video.seeking && video.paused === expectedPause
      && Math.abs(video.currentTime - target) < 0.8
      && Math.abs(Number(timeline.getAttribute('aria-valuenow')) - video.currentTime) < 0.25
      && !document.querySelector('[aria-label="Loading video"]')
      && ![...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Retry');
  }, {}, { videoSelector: VIDEO, timelineSelector: TIMELINE, target: seconds, expectedPause: paused });
}

async function errorVisible(page) {
  await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')]
    .some((element) => /not uploaded|Unable to load video/.test(element.textContent)
      && [...element.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Retry')));
  assert.equal((await media(page)).paused, true, 'A terminal error pauses the actual media element');
}

async function capture(page, name) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await delay(250); // Preserve real CSS, allowing its 150 ms loading/opacity transition to finish.
  const filename = `${name}-${page.viewport().width}.png`;
  await page.screenshot({ path: resolve(output, filename), fullPage: true });
  report.screenshots.push(filename);
}

async function layout(page, state) {
  const measured = await page.evaluate(() => {
    const labels = ['Jump back 10 seconds', 'Jump forward 10 seconds', 'Increase play speed by 1 step',
      'Decrease play speed by 1 step', 'Unmute', 'Mute', 'Pause', 'Unpause'];
    const buttons = [...document.querySelectorAll('button[aria-label]')]
      .filter((element) => labels.includes(element.getAttribute('aria-label')))
      .map((element) => ({ label: element.getAttribute('aria-label'), ...element.getBoundingClientRect().toJSON() }));
    const timestamp = [...document.querySelectorAll('.DriveView p')]
      .find((element) => /^\d\d:\d\d:\d\d\s+[–-]\s+\d+$/.test(element.textContent.trim()));
    const major = buttons.filter(({ label }) => !label.includes('play speed'));
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, buttons, major,
      timestamp: timestamp?.getBoundingClientRect().toJSON() };
  });
  report.layouts.push({ state, ...measured });
  assert.equal(measured.major.length, 4, 'Four major transport buttons remain available');
  assert.ok(measured.scrollWidth <= measured.width + 1, 'Page has no horizontal overflow');
  const centers = measured.major.map(({ y, height }) => y + height / 2);
  assert.ok(Math.max(...centers) - Math.min(...centers) <= 2, 'Major transport buttons share one row');
  assert.ok(measured.buttons.every(({ x, width }) => x >= -1 && x + width <= measured.width + 1), 'Every control fits horizontally');
  if (measured.width <= 390) {
    assert.ok(measured.timestamp, 'Playback timestamp exists');
    assert.ok(measured.timestamp.bottom <= Math.min(...measured.major.map(({ y }) => y)) + 1,
      'Narrow-layout timestamp is above the transport row');
  }
}

async function mapCapture(page, name) {
  const before = await media(page);
  if (page.viewport().width < 1536) await textButton(page, 'Map');
  await page.waitForSelector('.mapboxgl-canvas', { visible: true });
  const canvas = await page.$('.mapboxgl-canvas');
  await canvas.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  // The real DriveMap WebGL marker must render, not merely a blank canvas.
  let bluePixels = 0;
  for (let attempt = 0; attempt < 20 && bluePixels < 30; attempt += 1) {
    const png = PNG.sync.read(await canvas.screenshot());
    bluePixels = 0;
    for (let offset = 0; offset < png.data.length; offset += 4) {
      if (png.data[offset] < 45 && png.data[offset + 1] > 90 && png.data[offset + 1] < 170 && png.data[offset + 2] > 150) bluePixels += 1;
    }
    if (bluePixels < 30) await delay(100);
  }
  assert.ok(bluePixels >= 30, 'The route position marker is visible on the real map canvas');
  const after = await media(page);
  assert.equal(after.id, before.id, 'Map switch preserves the same video element');
  assert.ok(Math.abs(after.time - before.time) < 0.1, 'Paused map switch preserves media time');
  await capture(page, name);
  if (page.viewport().width < 1536) await textButton(page, 'Video');
}

async function main() {
  await mkdir(output, { recursive: true });
  report.sha = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
  report.candidate = process.env.QA_CANDIDATE_SHA;
  if (report.candidate) {
    await execute('git', ['diff', '--exit-code', report.candidate, '--', '.',
      ':!scripts/qa769.mjs', ':!.github/workflows/qa769.yaml']);
  }
  const missing = new Map();
  for (const name of ['missing-first', 'missing-middle']) {
    const manifest = await readFile(`public/demo-video/${name}.m3u8`, 'utf8');
    const uri = manifest.split('\n').find((line) => line.startsWith('https:'));
    assert.ok(uri, `${name} has a real missing-fragment URL`);
    missing.set(uri, await readFile(`public/demo-video/${name === 'missing-first' ? 0 : 1}/qcamera.ts`));
  }
  await build({ mode: 'production', build: { outDir: resolve(output, 'app'), sourcemap: false } });
  const server = await preview({ configFile: false, build: { outDir: resolve(output, 'app') },
    preview: { host: '127.0.0.1', port: 0, strictPort: true } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome',
    headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-background-networking', '--force-color-profile=srgb', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] })
    .catch(async (error) => { await server.close(); throw error; });
  report.browser = await browser.version();

  async function scenario(name, run, forceMse = false) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const result = { name, status: 'running', forceMse, requests: [], console: [], pageErrors: [], held: [], healed: new Set() };
    report.cases.push(result);
    try {
      page.setDefaultTimeout(15000);
      await page.setViewport(viewports[1]);
      await page.emulateTimezone('America/Los_Angeles');
      await page.setCacheEnabled(false);
      await page.evaluateOnNewDocument((forceMse) => {
        globalThis.qaOriginalCanPlayHls = document.createElement('video').canPlayType('application/vnd.apple.mpegurl');
        performance.setResourceTimingBufferSize(2000);
        if (forceMse) {
          const canPlayType = HTMLMediaElement.prototype.canPlayType;
          HTMLMediaElement.prototype.canPlayType = function (type) {
            return type === 'application/vnd.apple.mpegurl' ? '' : canPlayType.call(this, type);
          };
        }
        globalThis.qaEvents = [];
        let nextId = 0;
        for (const type of ['loadedmetadata', 'playing', 'pause', 'seeking', 'seeked', 'waiting', 'ended', 'error', 'emptied', 'ratechange', 'timeupdate']) {
          document.addEventListener(type, ({ target }) => {
            if (!(target instanceof HTMLVideoElement)) return;
            target.dataset.qaVideo ||= String(++nextId);
            globalThis.qaEvents.push({ type, id: target.dataset.qaVideo, time: target.currentTime,
              at: performance.now(), paused: target.paused, ready: target.readyState, rate: target.playbackRate,
              error: target.error && { code: target.error.code, message: target.error.message } });
            if (globalThis.qaEvents.length > 2000) globalThis.qaEvents.shift();
          }, true);
        }
      }, forceMse);
      page.on('pageerror', (error) => result.pageErrors.push(error.message));
      page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) result.console.push(message.text()); });
      const start = Math.floor(Date.now() / 60000) * 60000 - 180000;
      const route = { fullname: PUBLIC_ROUTE, dongle_id: PUBLIC_ROUTE.split('|')[0], url: `${origin}/demo-video`,
        create_time: start / 1000, start_time: new Date(start).toISOString().slice(0, 19),
        end_time: new Date(start + 180000).toISOString().slice(0, 19),
        start_time_utc_millis: start, end_time_utc_millis: start + 180000,
        segment_numbers: [0, 1, 2], segment_start_times: [0, 1, 2].map((i) => start + i * 60000),
        segment_end_times: [1, 2, 3].map((i) => start + i * 60000), maxqlog: 2, procqlog: 2,
        distance: 0.105, is_public: true, start_lat: 32.75, start_lng: -117.195, end_lat: 32.75, end_lng: -117.1932,
        startLocation: { place: 'Synthetic start', details: 'QA fixture' }, endLocation: { place: 'Synthetic end', details: 'QA fixture' } };
      const respond = (request, body, status = 200, contentType = 'application/json') => request.respond({
        status, contentType, headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store',
          'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' },
        body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
      });
      await page.setRequestInterception(true);
      page.on('request', async (request) => {
        try {
          const url = new URL(request.url());
          if (request.method() === 'OPTIONS') await respond(request, '', 204, 'text/plain');
          else if (missing.has(url.href)) {
            result.requests.push({ at: Date.now(), url: url.href, type: request.resourceType(),
              repaired: result.healed.has(url.href), held: Boolean(result.hold) });
            if (result.hold) { result.held.push(request); return; }
            await respond(request, result.healed.has(url.href) ? missing.get(url.href) : 'BlobNotFound',
              result.healed.has(url.href) ? 200 : 404, result.healed.has(url.href) ? 'video/mp2t' : 'text/plain');
          } else if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) await request.continue();
          else if (url.hostname === 'api.comma.ai' && url.pathname === '/v1/devices/5beb9b58bd12b691/routes_segments') await respond(request, [route]);
          else if (url.hostname === 'api.mapbox.com' && url.pathname.startsWith('/styles/v1/')) await respond(request, {
            version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#202c33' } }],
          });
          else if (url.hostname === 'api.mapbox.com' && url.pathname.startsWith('/geocoding/')) await respond(request, { features: [] });
          else if (url.hostname.endsWith('mapbox.com')) await respond(request, '', 204, 'text/plain');
          else { result.console.push(`Blocked external request: ${url.origin}${url.pathname}`); await request.abort('blockedbyclient'); }
        } catch (error) {
          if (!request.isInterceptResolutionHandled()) {
            result.pageErrors.push(`Interceptor: ${error.message}`);
            await request.abort('failed').catch(() => {});
          }
        }
      });
      const openRoute = async (kind) => {
        if (await page.$('.DriveView')) await click(page, '.DriveView [aria-label="Close"]');
        await click(page, routeLink(kind));
        await page.waitForSelector(VIDEO);
      };
      await page.goto(`${origin}/demo`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(routeLink('complete'));
      await run({ page, result, openRoute, respond });
      assert.deepEqual(result.pageErrors, [], 'No uncaught application errors');
      result.status = 'passed';
    } catch (error) {
      result.status = 'failed'; result.error = error.stack;
      await capture(page, `${name}-failure`).catch(() => {});
    } finally {
      result.mediaEvents = await page.evaluate(() => globalThis.qaEvents).catch(() => []);
      result.finalText = await page.$eval('body', (body) => body.innerText).catch(() => '');
      result.finalMedia = await media(page).catch(() => null);
      for (const request of result.held) await request.abort('aborted').catch(() => {});
      await context.close();
      delete result.held; delete result.healed; delete result.hold;
      console.log(`${result.status.toUpperCase()}: ${name}${result.error ? `\n${result.error}` : ''}`);
      await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
    }
  }

  try {
    await scenario('controls-and-responsive', async ({ page, openRoute }) => {
      await openRoute('complete'); await playing(page); await pause(page);
      const paused = await media(page); await delay(400);
      assert.ok(Math.abs((await media(page)).time - paused.time) < 0.05, 'Pause stops the actual clock');
      const target = await seek(page, 45); await settledAt(page, target);
      await page.focus(TIMELINE); await page.keyboard.press('ArrowRight'); await settledAt(page, target + 10);
      await click(page, 'button[aria-label="Jump back 10 seconds"]'); await settledAt(page, target);
      await click(page, 'button[aria-label="Jump forward 10 seconds"]'); await settledAt(page, target + 10);
      await click(page, 'button[aria-label="Increase play speed by 1 step"]');
      await click(page, 'button[aria-label="Increase play speed by 1 step"]');
      assert.equal((await media(page)).paused, true, 'Changing speed keeps paused video paused');
      await click(page, 'button[aria-label="Unmute"]'); assert.equal((await media(page)).muted, false);
      await click(page, 'button[aria-label="Unpause"]'); await playing(page);
      assert.equal((await media(page)).rate, 4, 'Native media uses selected 4x rate');
      assert.ok((await media(page)).audioBytes > 0, 'Chrome actually decodes the AAC track');
      await click(page, 'button[aria-label="Mute"]'); assert.equal((await media(page)).muted, true);
      const active = await media(page); await textButton(page, 'Map'); await playing(page);
      assert.equal((await media(page)).id, active.id, 'Playing Map switch preserves the video element');
      await textButton(page, 'Video'); await pause(page);
      await page.waitForSelector('.DriveView .thumbnailImage.images');
      for (const viewport of viewports) {
        await page.setViewport(viewport); await delay(150);
        await capture(page, 'video'); await layout(page, 'video'); await mapCapture(page, 'map');
        if (viewport.width === 390) {
          await page.focus(TIMELINE);
          for (let step = 0; step < 10; step += 1) {
            await page.keyboard.press('Tab');
            if (await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Jump back 10 seconds')) break;
          }
          const focus = await page.evaluate(() => {
            const element = document.activeElement; const style = getComputedStyle(element);
            return { label: element.getAttribute('aria-label'), visible: element.matches(':focus-visible'),
              outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth) };
          });
          assert.equal(focus.label, 'Jump back 10 seconds', 'Keyboard Tab reaches the playback controls');
          assert.ok(focus.visible && focus.outlineStyle !== 'none' && focus.outlineWidth >= 2, 'Keyboard focus has a visible outline');
          report.keyboardFocus = focus; await capture(page, 'keyboard-focus');
        }
      }
    });

    await scenario('missing-first-and-retry', async ({ page, result, openRoute }) => {
      await openRoute('first'); await errorVisible(page);
      for (const viewport of viewports) {
        await page.setViewport(viewport); await capture(page, 'missing-first-error'); await layout(page, 'error');
      }
      await page.setViewport(viewports[1]); await textButton(page, 'Map');
      await capture(page, 'map-with-error'); await errorVisible(page); await textButton(page, 'Video');
      await pause(page); const later = await seek(page, 125); await settledAt(page, later);
      await page.focus(TIMELINE); await page.keyboard.press('Home'); await errorVisible(page);
      const count = result.requests.length;
      result.healed.add([...missing.keys()][0]); await textButton(page, 'Retry'); await settledAt(page, 0);
      assert.ok(result.requests.length > count && result.requests.at(-1).repaired, 'Retry requests the repaired fragment');
      await click(page, 'button[aria-label="Unpause"]'); await playing(page);
    });

    await scenario('natural-chrome-middle-gap-recovery', async ({ page, result, openRoute }) => {
      await openRoute('middle'); await playing(page); await pause(page);
      await seek(page, 75); await errorVisible(page); await capture(page, 'natural-middle-gap');
      const count = result.requests.length; await textButton(page, 'Retry');
      await eventually(() => result.requests.length > count, 'Natural-browser Retry reattempts the missing middle fragment');
      await errorVisible(page);
      await settledAt(page, await seek(page, 125)); await click(page, 'button[aria-label="Unpause"]'); await playing(page);
      await capture(page, 'natural-middle-recovered');
    });

    await scenario('forced-mse-prefetch-and-loops', async ({ page, result, openRoute }) => {
      await openRoute('middle'); await playing(page); await pause(page);
      const transport = await media(page);
      assert.ok(transport.currentSrc.startsWith('blob:') && transport.hlsModuleLoaded, 'This scenario actually exercises hls.js/MSE');
      // Trigger the actual request near the buffered end, not an assumed paused prefetch threshold.
      await seek(page, 55); await click(page, 'button[aria-label="Unpause"]');
      await eventually(() => result.requests.length, 'Real HLS prefetch encounters missing middle fragment');
      await pause(page); result.prefetchMedia = await media(page);
      await delay(300);
      const slider = await page.$(TIMELINE); await slider.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      const box = await slider.boundingBox();
      await page.mouse.move(box.x + box.width / 180, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width * 15 / 180, box.y + box.height / 2, { steps: 8 }); await page.mouse.up();
      await page.waitForFunction((selector) => Number(document.querySelector(selector).getAttribute('aria-valuemax')) < 16, {}, TIMELINE);
      const bounds = await page.$eval(TIMELINE, (element) => ({
        start: Number(element.getAttribute('aria-valuemin')), end: Number(element.getAttribute('aria-valuemax')),
      }));
      assert.ok(bounds.start > 0 && bounds.start < 2 && bounds.end > 14, 'Pointer drag selects the intended valid loop');
      for (let step = 0; step < 3; step += 1) await click(page, 'button[aria-label="Increase play speed by 1 step"]');
      const eventStart = await page.evaluate(() => globalThis.qaEvents.length);
      await click(page, 'button[aria-label="Unpause"]'); await playing(page); await delay(2500); await pause(page);
      const times = await page.evaluate((start) => globalThis.qaEvents.slice(start)
        .filter(({ type }) => type === 'timeupdate').map(({ time }) => time), eventStart);
      assert.ok(times.some((time, index) => index && times[index - 1] - time > 5), 'Playback wraps the selected loop');
      assert.ok(times.every((time) => time >= bounds.start - 0.8 && time <= bounds.end + 0.8), 'Observed loop playback stays in bounds');
      assert.equal(await page.$('[aria-label="Loading video"]'), null, 'Future fragment failure does not stall a healthy buffered loop');
      assert.equal(await page.$$eval('button', (buttons) => buttons.some((button) => button.textContent.trim() === 'Retry')), false,
        'Future fragment failure does not replace a healthy loop with an error');
      await capture(page, 'healthy-loop-after-prefetch-failure');
      await click(page, '.DriveView button[aria-label="Go Back"]');
      await page.waitForFunction((selector) => Number(document.querySelector(selector).getAttribute('aria-valuemax')) === 180, {}, TIMELINE);
      await seek(page, 75); await errorVisible(page); await capture(page, 'missing-middle-error');
      const count = result.requests.length; await textButton(page, 'Retry');
      await eventually(() => result.requests.length > count, 'Retry reattempts a still-missing fragment'); await errorVisible(page);
      await settledAt(page, await seek(page, 125)); await click(page, 'button[aria-label="Unpause"]'); await playing(page);
    }, true);

    await scenario('navigation-cancellation-and-loading', async ({ page, result, openRoute, respond }) => {
      result.hold = true; await openRoute('first');
      await eventually(() => result.held.length, 'Old route has an in-flight real fragment request');
      await page.waitForSelector('[aria-label="Loading video"]', { visible: true });
      await capture(page, 'loading');
      const placement = await page.evaluate((selector) => {
        const video = document.querySelector(selector).getBoundingClientRect();
        const spinner = document.querySelector('[aria-label="Loading video"]').getBoundingClientRect();
        return { x: Math.abs(video.x + video.width / 2 - spinner.x - spinner.width / 2),
          y: Math.abs(video.y + video.height / 2 - spinner.y - spinner.height / 2) };
      }, VIDEO);
      assert.ok(placement.x < 2 && placement.y < 2, 'Loading indicator is centered in the video');
      const oldVideo = await page.$(VIDEO);
      result.hold = false; await openRoute('complete'); await playing(page);
      assert.equal(await oldVideo.evaluate((element) => element.isConnected), false, 'Navigation unmounts the old route video');
      const before = await media(page);
      for (const request of result.held.splice(0)) {
        await respond(request, 'BlobNotFound', 404, 'text/plain').catch((error) => result.console.push(`Old request cancelled: ${error.message}`));
      }
      await playing(page);
      assert.equal((await media(page)).id, before.id, 'Settling old transport work preserves new route media');
      assert.equal(await page.$$eval('button', (buttons) => buttons.some((button) => button.textContent.trim() === 'Retry')), false,
        'Old route failure does not surface on the new route');
    });
  } finally {
    await browser.close(); await server.close();
  }
  report.finished = new Date().toISOString();
  report.passed = report.cases.every(({ status }) => status === 'passed');
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  assert.ok(report.passed, 'One or more browser QA scenarios failed; inspect report.json and screenshots');
}

main().catch(async (error) => {
  report.fatalError = error.stack;
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.error(error); process.exitCode = 1;
});
