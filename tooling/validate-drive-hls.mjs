// Fork-only validation: run against the unmodified Docker app, never a live account.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resetCaptureScroll, verifyPlaybackControls } from '../scripts/gallery-checks.mjs';

const { values } = parseArgs({ options: {
  origin: { type: 'string', default: 'http://127.0.0.1:8080' },
  output: { type: 'string', default: 'drive-hls-results' },
} });
const origin = new URL(values.origin).origin;
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'Use a loopback app origin');
const output = resolve(values.output);
const toolingDirectory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve('package.json'));
const DONGLE = 'aaaaaaaaaaaaaaaa';
const LOG = '2026-08-06--12-00-00';
const FULLNAME = `${DONGLE}|${LOG}`;
const DRIVE_PATH = `/${DONGLE}/${LOG}`;
const VIDEO = '.DriveView video';
const WAIT = { timeout: 15000, polling: 50 };
const report = {
  sourceSha: process.env.GITHUB_SHA || null,
  origin,
  startedAt: new Date().toISOString(),
  scope: 'Unmodified built app with actual HLS.js and browser decoder; all account/device/media responses are synthetic and intercepted.',
  limitations: 'No live device, signed media URL, remote CDN, adaptive bitrate, audio, or Safari/native-HLS verification.',
  passed: false,
  cases: [],
};

async function loadFixture(directory, sdk) {
  const fixtureDirectory = resolve(toolingDirectory, directory);
  const metadata = JSON.parse(await readFile(resolve(fixtureDirectory, 'validation.json'), 'utf8'));
  const assets = new Map(await Promise.all(Object.entries(metadata.files).map(async ([name, expected]) => {
    const bytes = await readFile(resolve(fixtureDirectory, name));
    assert.equal(bytes.length, expected.bytes, `${directory}/${name} size changed`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, `${directory}/${name} checksum changed`);
    return [name, bytes];
  })));
  assets.set('sdk', sdk);
  return { metadata, assets };
}

function fixtureData() {
  const now = Math.floor(Date.now() / 1000);
  const start = Date.UTC(2026, 7, 6, 12);
  const route = {
    fullname: FULLNAME, dongle_id: DONGLE, create_time: start / 1000,
    start_time: '2026-08-06T12:00:00', end_time: '2026-08-06T12:00:08',
    start_time_utc_millis: start, end_time_utc_millis: start + 8000,
    segment_numbers: [0], segment_start_times: [start], segment_end_times: [start + 8000],
    maxqlog: 0, procqlog: 0, distance: 0.1, make: 'ford', platform: 'FORD_BRONCO_SPORT_MK1',
    is_public: true, is_preserved: true, version: '0.10.4', url: `${origin}/__hls-route`,
    start_lat: 32.75, start_lng: -117.19, end_lat: 32.75, end_lng: -117.19,
    startLocation: { place: 'Synthetic start', details: 'Validation fixture' },
    endLocation: { place: 'Synthetic end', details: 'Validation fixture' },
  };
  const device = {
    dongle_id: DONGLE, alias: 'Synthetic HLS device', device_type: 'tici',
    is_owner: true, prime: false, version: '0.10.4', serial: 'fixture-only',
    fetched_at: now, last_athena_ping: now, rpc: { not_car: false },
  };
  return { route, device, profile: { id: 'hls-fixture', user_id: 'hls-fixture', email: 'fixture@example.invalid', superuser: false } };
}

function respond(request, body, contentType = 'application/json', status = 200) {
  return request.respond({ status, contentType, body,
    headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
  });
}

async function intercept(request, data, assets, result) {
  const url = new URL(request.url());
  if (['data:', 'blob:'].includes(url.protocol)) return request.continue();
  const path = decodeURIComponent(url.pathname).replace(/\/$/, '');
  const json = (value) => respond(request, JSON.stringify(value));
  if (url.origin === origin) {
    if (path.startsWith('/__hls-fixture/')) {
      const name = path.slice('/__hls-fixture/'.length);
      assert(assets.has(name) && name.endsWith('.ts'), `Unknown HLS segment ${name}`);
      result.segments.push(name);
      return respond(request, assets.get(name), 'video/mp2t');
    }
    if (path === '/__hls-route/0/events.json' || path === '/__hls-route/0/coords.json') return json([]);
    if (path === '/__hls-route/0/sprite.jpg') {
      return respond(request, assets.get('sprite.jpg'), 'image/jpeg');
    }
    return request.continue();
  }
  if (url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('/hls.js@')) {
    assert.equal(url.pathname, '/npm/hls.js@1.4.8/dist/hls.min.js');
    result.sdkRequests += 1;
    return respond(request, assets.get('sdk'), 'text/javascript');
  }
  if (!['api.comma.ai', 'billing.comma.ai', 'athena.comma.ai'].includes(url.hostname)) {
    result.blockedExternal.push(`${request.method()} ${url.origin}${url.pathname}`);
    return request.abort('blockedbyclient');
  }
  if (request.method() === 'OPTIONS') {
    return request.respond({ status: 204, headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    } });
  }
  result.backendRequests.push(`${request.method()} ${url.hostname}${path}`);
  if (url.hostname === 'api.comma.ai' && request.method() === 'GET') {
    if (path === '/v1/me') return json(data.profile);
    if (path === '/v1/me/devices') return json([data.device]);
    if (path === '/v1/me/turn') return json({ iceServers: [] });
    if (path === `/v1.1/devices/${DONGLE}`) return json(data.device);
    if (path === `/v1.1/devices/${DONGLE}/stats`) return json({ all: { distance: 1, minutes: 1, routes: 1 } });
    if (path === `/v1/devices/${DONGLE}/location`) return json({ lat: 32.75, lng: -117.19, time: Math.floor(Date.now() / 1000) });
    if ([`/v1/devices/${DONGLE}/routes_segments`, `/v1/devices/${DONGLE}/routes/preserved`].includes(path)) return json([data.route]);
    if (path === `/v1/devices/${DONGLE}/athena_offline_queue`) return json([]);
    if (path === `/v1/route/${FULLNAME}/files`) return json({});
    if (path === `/v1/route/${FULLNAME}/qcamera.m3u8`) {
      result.manifestRequests += 1;
      const manifest = assets.get('playlist.m3u8').toString().replace(/^segment-\d+\.ts$/gm, (name) => `${origin}/__hls-fixture/${name}`);
      return respond(request, manifest, 'application/vnd.apple.mpegurl');
    }
  }
  if (url.hostname === 'billing.comma.ai' && request.method() === 'GET') {
    if (path === '/v1/prime/subscribe_info') return json({ eligible: false, device_online: true });
    if (path === '/v1/prime/subscription') return json(null);
  }
  if (url.hostname === 'athena.comma.ai' && path === `/${DONGLE}` && request.method() === 'POST') {
    const payload = JSON.parse(request.postData() || '{}');
    result.athenaMethods.push(payload.method);
    const replies = {
      getNotCar: false, getNetworkMetered: false, getNetworkType: 1,
      getMessage: { peripheralState: { voltage: 12300 } }, listUploadQueue: [],
      setRouteViewed: true,
    };
    assert(Object.hasOwn(replies, payload.method), `Unexpected synthetic Athena method ${payload.method}`);
    return json({ jsonrpc: '2.0', id: payload.id, result: replies[payload.method] });
  }
  throw new Error(`Unmocked backend request: ${request.method()} ${url.hostname}${path}`);
}

async function mediaState(page) {
  return page.$eval(VIDEO, (video) => ({
    currentTime: video.currentTime, duration: video.duration, paused: video.paused, seeking: video.seeking,
    readyState: video.readyState, width: video.videoWidth, height: video.videoHeight,
    frames: video.getVideoPlaybackQuality().totalVideoFrames,
    currentSrc: video.currentSrc, error: video.error?.message || null,
    sameVideo: video === window.__hlsValidationVideo,
    hlsVersion: window.Hls?.version,
    observedAt: performance.now(),
  }));
}

async function retainedPlayback(page, reference) {
  const state = await mediaState(page);
  assert(state.sameVideo, 'Dialog navigation replaced the video element');
  assert.equal(state.currentSrc, reference.currentSrc, 'Dialog navigation replaced the MediaSource');
  assert(state.paused, 'Dialog navigation resumed paused playback');
  assert(Math.abs(state.currentTime - reference.currentTime) < 0.2, 'Dialog navigation moved playback');
  assert(state.frames >= reference.frames, 'Dialog navigation reset decoded frame count');
  assert.equal(state.error, null);
  return state;
}

async function seekTimeline(page, seconds) {
  const timeline = await page.$('[role="slider"][aria-label="Drive timeline"]');
  assert(timeline, 'Drive timeline is missing');
  await timeline.scrollIntoView();
  const box = await timeline.boundingBox();
  assert(box && box.width > 0 && box.height > 0, 'Drive timeline is not visible');
  await page.mouse.click(box.x + box.width * (seconds / 8), box.y + box.height * 0.5);
  await page.waitForFunction((selector, target) => {
    const video = document.querySelector(selector);
    return video && video.paused && !video.seeking && Math.abs(video.currentTime - target) < 0.2;
  }, WAIT, VIDEO, seconds);
}

async function navigateInfo(page, action) {
  switch (action) {
    case 'open': {
      const moreInfo = await page.$('::-p-text(More info)');
      assert(moreInfo, 'Route-info trigger is missing');
      await moreInfo.click();
      break;
    }
    case 'back': await page.evaluate(() => history.back()); break;
    case 'forward': await page.evaluate(() => history.forward()); break;
    case 'close': await page.keyboard.press('Escape'); break;
    default: throw new Error(`Unknown dialog action: ${action}`);
  }
  const open = action === 'open' || action === 'forward';
  await page.waitForFunction((expected) => new URLSearchParams(location.search).get('dialog') === expected,
    WAIT, open ? 'route-info' : null);
  await page.waitForSelector('#menu-info', { [open ? 'visible' : 'hidden']: true, timeout: 15000 });
}

async function retainedPlaying(page, previous) {
  const state = await mediaState(page);
  const elapsed = (state.observedAt - previous.observedAt) / 1000;
  assert(state.sameVideo, 'Playing navigation replaced the video element');
  assert.equal(state.currentSrc, previous.currentSrc, 'Playing navigation replaced the MediaSource');
  assert(!state.paused, 'Dialog navigation paused active playback');
  assert(state.currentTime >= previous.currentTime - 0.1, 'Playing navigation reset playback position');
  assert(state.currentTime <= previous.currentTime + elapsed + 0.5, 'Playing navigation skipped ahead');
  assert(state.frames >= previous.frames, 'Playing navigation reset decoded frame count');
  assert.equal(state.error, null);
  return state;
}

async function verifyPlayingNavigation(page, result) {
  result.phase = 'continuous playback setup';
  await seekTimeline(page, 1);
  const reference = await mediaState(page);
  await page.click('button[aria-label="Unpause"]');
  await page.waitForFunction((selector, time, frames) => {
    const video = document.querySelector(selector);
    return video && !video.paused && video.currentTime > time + 0.3
      && video.getVideoPlaybackQuality().totalVideoFrames > frames;
  }, WAIT, VIDEO, reference.currentTime, reference.frames);
  await page.$eval(VIDEO, (video) => {
    window.__hlsValidationPauses = [];
    video.addEventListener('pause', () => window.__hlsValidationPauses.push({
      currentTime: video.currentTime, observedAt: performance.now(),
    }));
  });
  const continuous = { start: await retainedPlaying(page, reference) };
  result.continuous = continuous;
  result.phase = 'playing open URL dialog';
  await navigateInfo(page, 'open');
  continuous.dialog = await retainedPlaying(page, continuous.start);
  result.phase = 'playing Back';
  await navigateInfo(page, 'back');
  continuous.back = await retainedPlaying(page, continuous.dialog);
  result.phase = 'playing Forward';
  await navigateInfo(page, 'forward');
  continuous.forward = await retainedPlaying(page, continuous.back);
  result.phase = 'playing Close';
  await navigateInfo(page, 'close');
  continuous.closed = await retainedPlaying(page, continuous.forward);
  continuous.pauseEvents = await page.evaluate(() => window.__hlsValidationPauses);
  assert.deepEqual(continuous.pauseEvents, [], 'Playback paused during dialog/history navigation');
  assert(continuous.closed.currentTime > continuous.start.currentTime + 0.2, 'Playback did not advance during navigation');
  assert(continuous.closed.frames > continuous.start.frames, 'No new frames decoded during navigation');
  result.phase = 'final paused capture';
  await page.click('button[aria-label="Pause"]');
  await page.waitForFunction((selector) => document.querySelector(selector)?.paused, WAIT, VIDEO);
  await seekTimeline(page, 4);
  await verifyCaptureReady(page, result);
}

async function verifyCaptureReady(page, result) {
  // Native seeking can finish before DriveVideo's next buffering-state update.
  await page.waitForSelector('.DriveView [role="progressbar"]', { hidden: true, timeout: WAIT.timeout });
  await page.waitForFunction((selector) => {
    const video = document.querySelector(selector);
    return video && video.readyState >= 2 && !video.seeking && video.paused;
  }, WAIT, VIDEO);
  result.finalCapture = await mediaState(page);
  result.finalCapture.bufferingOverlayCleared = true;
  assert.equal(result.finalCapture.error, null);
}

async function verifySpeedSelection(page, result) {
  result.phase = 'paused fractional speed selection';
  await verifyCaptureReady(page, result);
  const reference = await mediaState(page);
  const selector = 'select[aria-label="Playback speed"]';
  await page.focus(selector);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await page.waitForFunction((target) => document.querySelector(target)?.value === '0.25', WAIT, selector);
  const paused = await retainedPlayback(page, reference);
  const size = await page.$eval(selector, (select) => {
    const probe = select.cloneNode(true);
    probe.setAttribute('aria-hidden', 'true');
    Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', width: 'auto',
      minWidth: '0', maxWidth: 'none', font: getComputedStyle(select).font });
    document.body.append(probe);
    const intrinsicWidth = probe.getBoundingClientRect().width;
    probe.remove();
    return { text: select.selectedOptions[0].textContent, width: select.getBoundingClientRect().width,
      height: select.getBoundingClientRect().height, intrinsicWidth,
      fits: select.getBoundingClientRect().width + 1 >= intrinsicWidth };
  });
  result.speedSelection = { selectedRate: 0.25, paused, size };
  assert(size.fits, `Native speed label is clipped: ${JSON.stringify(size)}`);
  await resetCaptureScroll(page);
  const screenshot = `${result.name}-fractional-speed.png`;
  await page.screenshot({ path: resolve(output, screenshot), fullPage: true });
  result.speedSelection.screenshot = screenshot;
  await page.focus(selector);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await page.waitForFunction((target) => document.querySelector(target)?.value === '1', WAIT, selector);
  result.speedSelection.restoredRate = 1;
  result.speedSelection.restored = await retainedPlayback(page, reference);
}

async function runCase(browser, fixture, name, viewport, historyChecks = true) {
  const { assets, metadata } = fixture;
  const result = { name, viewport, checks: historyChecks ? 'decode, seek, fractional speed, paused/playing history and layout' : 'decode, seek, fractional speed and layout',
    intrinsicSize: [metadata.width, metadata.height], passed: false, phase: 'setup', sdkRequests: 0, manifestRequests: 0,
    segments: [], backendRequests: [], athenaMethods: [], blockedExternal: [], pageErrors: [], requestErrors: [], consoleErrors: [] };
  report.cases.push(result);
  let context;
  let page;
  try {
    context = await browser.createBrowserContext();
    page = await context.newPage();
    await page.setViewport(viewport);
    await page.evaluateOnNewDocument(() => localStorage.setItem('authorization', 'synthetic-hls-validation-token'));
    page.on('pageerror', (error) => result.pageErrors.push(String(error.stack || error)));
    page.on('console', (message) => { if (message.type() === 'error') result.consoleErrors.push(message.text()); });
    await page.setRequestInterception(true);
    const data = fixtureData();
    page.on('request', (request) => {
      intercept(request, data, assets, result).catch(async (error) => {
        result.requestErrors.push(String(error.stack || error));
        if (!request.isInterceptResolutionHandled()) await request.abort('failed').catch(() => {});
      });
    });
    result.phase = 'cold-link decode';
    await page.goto(`${origin}${DRIVE_PATH}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction((selector, width, height) => {
      const video = document.querySelector(selector);
      return video && video.readyState >= 2 && video.videoWidth === width && video.videoHeight === height && video.currentTime >= 0.3
        && video.currentTime < 7 && video.getVideoPlaybackQuality().totalVideoFrames >= 3;
    }, WAIT, VIDEO, metadata.width, metadata.height);
    await page.$eval(VIDEO, (video) => { window.__hlsValidationVideo = video; });
    result.initial = await mediaState(page);
    assert.equal(result.initial.hlsVersion, '1.4.8');
    assert.equal(result.initial.height, metadata.height);
    assert.equal(result.initial.error, null);
    assert(result.initial.currentSrc.startsWith('blob:'), 'HLS must attach an actual MediaSource');
    assert(Math.abs(result.initial.duration - 8) < 0.1, 'Unexpected HLS duration');
    result.phase = 'play';
    await page.waitForFunction((selector, time, frames) => {
      const video = document.querySelector(selector);
      return video && video.currentTime > time + 0.3 && video.getVideoPlaybackQuality().totalVideoFrames > frames;
    }, WAIT, VIDEO, result.initial.currentTime, result.initial.frames);
    result.playing = await mediaState(page);
    await page.click('button[aria-label="Pause"]');
    await page.waitForFunction((selector) => document.querySelector(selector)?.paused, WAIT, VIDEO);
    result.phase = 'timeline seek';
    await seekTimeline(page, 4);
    result.seek = await mediaState(page);
    await verifySpeedSelection(page, result);
    if (historyChecks) {
      result.phase = 'open URL dialog';
      await navigateInfo(page, 'open');
      result.dialog = await retainedPlayback(page, result.seek);
      result.phase = 'Back';
      await navigateInfo(page, 'back');
      result.back = await retainedPlayback(page, result.seek);
      result.phase = 'Forward';
      await navigateInfo(page, 'forward');
      result.forward = await retainedPlayback(page, result.seek);
      result.phase = 'Close';
      await navigateInfo(page, 'close');
      result.closed = await retainedPlayback(page, result.seek);
      await verifyPlayingNavigation(page, result);
    } else {
      await verifyCaptureReady(page, result);
    }
    result.phase = 'rendered geometry';
    result.geometry = await verifyPlaybackControls(page, name);
    assert(result.geometry.layout.decodedAspect?.matches, 'Decoded-video aspect was not verified');
    assert.equal(new URL(page.url()).pathname, DRIVE_PATH);
    assert.equal(result.sdkRequests, 1, 'Dialog changes reloaded the HLS SDK');
    assert.equal(result.manifestRequests, 1, 'Dialog changes restarted the HLS source');
    assert.equal(new Set(result.segments).size, 4, 'The full synthetic source was not loaded');
    assert(!await page.evaluate(() => /Unable to load video|This video segment has not uploaded/.test(document.body.innerText)), 'The app displayed a video error');
    assert.deepEqual(result.pageErrors, []);
    assert.deepEqual(result.requestErrors, []);
    result.phase = 'complete';
    result.passed = true;
  } catch (error) {
    result.error = String(error.stack || error);
    if (page) {
      result.mediaAtFailure = await mediaState(page).catch(() => null);
      await page.content().then((html) => writeFile(resolve(output, `${name}-failure.html`), html)).catch(() => {});
    }
  } finally {
    result.url = page?.url() || null;
    if (page) {
      const screenshot = `${name}${result.passed ? '' : '-failure'}.png`;
      try {
        await resetCaptureScroll(page);
        result.captureScroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
        await page.screenshot({ path: resolve(output, screenshot), fullPage: true });
        result.screenshot = screenshot;
      } catch (error) {
        result.screenshotError = String(error);
        if (result.passed) result.phase = 'capture';
        result.passed = false;
      }
    }
    if (context) {
      await context.close().catch((error) => {
        result.cleanupError = String(error.stack || error);
        result.passed = false;
      });
    }
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${name}: ${result.phase}${result.error ? `\n${result.error}` : ''}`);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

async function writeReport() {
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const images = await Promise.all(report.cases.flatMap((result) => [
    { path: result.speedSelection?.screenshot, label: 'Paused at .25×' },
    { path: result.screenshot, label: `Final capture: ${result.phase}` },
  ].filter((capture) => capture.path).map(async (capture) => {
    const png = await readFile(resolve(output, capture.path));
    return `<section><h2>${escapeHtml(result.name)} — ${result.passed ? 'PASS' : 'FAIL'} — ${escapeHtml(capture.label)}</h2><p>${escapeHtml(result.checks)}</p><img alt="${escapeHtml(result.name)} ${escapeHtml(capture.label)}" src="data:image/png;base64,${png.toString('base64')}"></section>`;
  })));
  await writeFile(resolve(output, 'report.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Actual HLS drive verification</title><style>body{font:16px system-ui;background:#17222b;color:#eee;margin:24px}img{display:block;max-width:100%;height:auto;border:1px solid #58636b}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0d151b;padding:16px}section{margin:24px 0}h1,h2{line-height:1.2}</style><h1>Actual HLS drive verification: ${report.passed ? 'PASS' : 'FAIL'}</h1><p>${escapeHtml(report.scope)}</p><p>Source: ${escapeHtml(report.sourceSha || 'not supplied')}</p><p>${escapeHtml(report.limitations)}</p>${images.join('')}<h2>Recorded evidence</h2><pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre></html>\n`);
}

let browser;
await mkdir(output, { recursive: true });
try {
  report.versions = Object.fromEntries(await Promise.all(['puppeteer', 'hls.js'].map(async (name) => {
    const metadata = JSON.parse(await readFile(resolve('node_modules', name, 'package.json'), 'utf8'));
    return [name, metadata.version];
  })));
  assert.deepEqual(report.versions, { puppeteer: '24.16.0', 'hls.js': '1.4.8' });
  const sdk = await readFile(require.resolve('hls.js'));
  report.sdkSha256 = createHash('sha256').update(sdk).digest('hex');
  const [widescreen, cameraAspect] = await Promise.all([
    loadFixture('drive-hls-fixture', sdk),
    loadFixture('drive-hls-native-fixture', sdk),
  ]);
  report.fixtures = { widescreen: widescreen.metadata, cameraAspect: cameraAspect.metadata };
  const puppeteer = require('puppeteer');
  browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });
  report.browserVersion = await browser.version();
  await runCase(browser, widescreen, 'desktop', { width: 1280, height: 900, deviceScaleFactor: 1 });
  await runCase(browser, widescreen, 'mobile', { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await runCase(browser, cameraAspect, 'camera-desktop', { width: 1280, height: 900, deviceScaleFactor: 1 }, false);
  await runCase(browser, cameraAspect, 'camera-mobile', { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, false);
  await runCase(browser, cameraAspect, 'camera-narrow', { width: 320, height: 700, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, false);
  await runCase(browser, cameraAspect, 'camera-wide', { width: 1536, height: 960, deviceScaleFactor: 1 }, false);
  report.passed = report.cases.length === 6 && report.cases.every((result) => result.passed);
} catch (error) {
  report.error = String(error.stack || error);
  console.error(report.error);
} finally {
  try {
    if (browser) await browser.close();
  } catch (error) {
    report.cleanupError = String(error.stack || error);
    report.passed = false;
  } finally {
    await writeReport();
    if (!report.passed) process.exitCode = 1;
  }
}
