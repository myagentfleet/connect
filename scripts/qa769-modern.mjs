/* Validation only: publish on a separate QA branch, never in the fix PR. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { build, preview } from 'vite';

const execute = promisify(execFile);
const output = resolve(process.env.QA769_OUTPUT || 'qa769-results');
const fixtures = resolve(process.env.QA769_FIXTURES || 'public/demo-video');
const captureOnly = process.env.QA769_CAPTURE_ONLY === 'true';
const caseFilter = process.env.QA769_CASE?.trim() || null;
const headless = process.env.QA769_HEADLESS !== 'false';
const VIDEO = '.DriveView video';
const TIMELINE = '[role="slider"][aria-label="Drive timeline"]';
const SPEED = 'button[aria-label="Playback speed"]';
const ELAPSED = '[aria-label="Selection playback time"]';
const VIDEO_TOGGLE = 'button[aria-label="Play video"], button[aria-label="Pause video"]';
const PUBLIC_ROUTE = '5beb9b58bd12b691|0000010a--a51155e496';
const PUBLIC_ASSET_PREFIX = `/demo-video/${PUBLIC_ROUTE.replace('|', '/')}`;
const routes = { complete: 11, first: 12, middle: 13 };
const viewports = [320, 390, 1280, 1600].map((width) => ({ width, height: width < 600 ? 844 : 800, deviceScaleFactor: 1 }));
const report = {
  started: new Date().toISOString(), revision: process.env.QA769_REVISION_LABEL || 'candidate',
  captureOnly, caseFilter, headless, cases: [], layouts: [], screenshots: [],
  playbackVerification: 'Require 200ms without a seek or invalid playback state, media-clock advancement above 0.15s, and new decoded frames after that baseline.',
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
  id: video.dataset.qaVideo, time: video.currentTime, duration: video.duration, paused: video.paused, seeking: video.seeking,
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
  await page.evaluate(() => { globalThis.qaPlaybackProbe = null; });
  await page.waitForFunction((selector) => {
    const video = document.querySelector(selector);
    if (!video || video.paused || video.seeking || video.readyState < 2 || video.videoWidth === 0) {
      globalThis.qaPlaybackProbe = null;
      return false;
    }
    const id = video.dataset.qaVideo;
    const seeks = globalThis.qaEvents.filter((event) => event.id === id && event.type === 'seeking').length;
    const sample = { id, seeks, at: performance.now(), time: video.currentTime,
      frames: video.getVideoPlaybackQuality?.().totalVideoFrames || 0 };
    const before = globalThis.qaPlaybackProbe;
    // A seek can advance time and decode a frame without starting continuous playback.
    if (!before || before.id !== id || before.seeks !== seeks) {
      globalThis.qaPlaybackProbe = sample;
      return false;
    }
    return sample.at - before.at >= 200 && sample.time > before.time + 0.15 && sample.frames > before.frames;
  }, {}, VIDEO);
}

async function pause(page) {
  if (await page.$('button[aria-label="Pause"]')) await click(page, 'button[aria-label="Pause"]');
  await page.waitForFunction((selector) => document.querySelector(selector)?.paused, {}, VIDEO);
  await page.waitForSelector('button[aria-label="Play"]');
}

async function speed(page, value) {
  await click(page, SPEED);
  const option = await page.waitForFunction((text) => [...document.querySelectorAll('[role="menuitemradio"]')]
    .find((element) => element.textContent.trim() === text), {}, `${value}×`);
  await option.asElement().click();
  await page.waitForSelector('[role="menuitemradio"]', { hidden: true });
  await page.waitForFunction(({ selector, rate }) => document.querySelector(selector).textContent.trim() === `${rate}×`, {},
    { selector: SPEED, rate: value });
  await page.waitForFunction(({ selector, rate }) => document.querySelector(selector).playbackRate === rate, {},
    { selector: VIDEO, rate: value });
}

async function elapsedTime(page) {
  const actual = await page.$eval(ELAPSED, (element) => element.textContent.trim().replace(/\s+/g, ' '));
  const bounds = await page.$eval(TIMELINE, (element) => ({
    start: Number(element.getAttribute('aria-valuemin')), end: Number(element.getAttribute('aria-valuemax')),
    now: Number(element.getAttribute('aria-valuenow')),
  }));
  const toSeconds = (text) => text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  assert.match(actual, /^\d+:\d{2}(?::\d{2})? \/ \d+:\d{2}(?::\d{2})?$/, 'Elapsed and total are legible playback times');
  const [elapsed, total] = actual.split(' / ').map(toSeconds);
  assert.ok(Math.abs(total - (bounds.end - bounds.start)) < 1, 'Displayed total is the current selection duration');
  assert.ok(Math.abs(elapsed - (bounds.now - bounds.start)) < 1, 'Displayed elapsed time follows the media-driven timeline');
  return actual;
}

async function speedKeyboard(page) {
  await page.focus(SPEED);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitemradio');
  assert.equal(await page.$eval(`${SPEED}[aria-expanded="true"]`, (element) => element.getAttribute('aria-controls')),
    'playback-speed-menu', 'The speed button identifies its open menu');
  assert.equal(await page.$$eval('[role="menuitemradio"][aria-checked="true"]', (elements) => elements.length), 1,
    'Exactly one speed option is checked');
  const rows = await page.$$eval('[role="menuitemradio"]', (elements) => elements.map((element) => ({
    label: element.textContent.trim(), height: element.getBoundingClientRect().height,
  })));
  assert.ok(rows.length > 0 && rows.every(({ height }) => height >= 44 && height <= 45),
    'Every playback speed menu row is between 44px and 45px high');
  report.speedMenus ||= []; report.speedMenus.push({ width: page.viewport().width, rows });
  const selected = await page.evaluate(() => document.activeElement.textContent.trim());
  await page.keyboard.press('ArrowDown');
  assert.notEqual(await page.evaluate(() => document.activeElement.textContent.trim()), selected, 'ArrowDown moves within the speed menu');
  await capture(page, 'speed-menu-keyboard', true);
  await page.keyboard.press('Escape');
  await page.waitForSelector('[role="menuitemradio"]', { hidden: true });
  await page.waitForFunction((selector) => document.activeElement === document.querySelector(selector), {}, SPEED);
  assert.equal(await page.$eval(SPEED, (element) => element.getAttribute('aria-expanded')), 'false', 'Escape closes the menu and restores trigger focus');
}

async function adjacentMenus(page) {
  for (const [label, id, expectedText] of [['Files', 'menu-download', 'Road camera'], ['More info', 'menu-info', 'View in useradmin']]) {
    const trigger = await page.waitForFunction((text) => [...document.querySelectorAll('.DriveView button')]
      .find((element) => element.textContent.trim() === text), {}, label);
    const recordFocus = async (phase) => {
      const snapshot = await trigger.evaluate((element, menuId) => {
        const describe = (node) => node && ({ tag: node.tagName, id: node.id, label: node.getAttribute('aria-label'),
          text: node.textContent.trim().slice(0, 100), connected: node.isConnected, tabIndex: node.tabIndex,
          ariaHiddenAncestor: node.closest('[aria-hidden="true"]')?.outerHTML.slice(0, 250) || null });
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return { at: performance.now(), documentFocused: document.hasFocus(), activeElement: describe(document.activeElement),
          trigger: { ...describe(element), disabled: element.disabled, ariaDisabled: element.getAttribute('aria-disabled'),
            display: style.display, visibility: style.visibility, rect: rect.toJSON(), inertAncestor: Boolean(element.closest('[inert]')),
            focusable: element.isConnected && !element.disabled && element.tabIndex >= 0 && style.display !== 'none'
              && style.visibility === 'visible' && rect.width > 0 && rect.height > 0 && !element.closest('[inert]') },
          menu: describe(document.getElementById(menuId)), triggerFocused: document.activeElement === element };
      }, id);
      const entry = { label, phase, ...snapshot };
      report.menuFocus ||= []; report.menuFocus.push(entry);
      console.log(`MENU_FOCUS ${JSON.stringify(entry)}`);
      await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
    };
    try {
      await trigger.asElement().focus();
      await recordFocus('before-open');
      await page.keyboard.press('Enter');
      await page.waitForSelector(`#${id}`, { visible: true });
      assert.equal(await trigger.evaluate((element) => element.getAttribute('aria-expanded')), 'true', `${label} reports its open state`);
      await page.waitForFunction(({ id, text }) => document.getElementById(id)?.textContent.includes(text), {}, { id, text: expectedText });
      await recordFocus('ready');
      if (label === 'More info') {
        // MUI Popover grows the Paper immediately around its role=menu list.
        const settled = await page.waitForFunction((menuId) => {
          const menu = document.getElementById(menuId)?.querySelector('[role="menu"]');
          const paper = menu?.parentElement;
          if (!paper) return false;
          const style = getComputedStyle(paper);
          const rect = paper.getBoundingClientRect();
          const animations = paper.getAnimations().map(({ playState, pending }) => ({ playState, pending }));
          const identity = style.transform === 'none' || new DOMMatrixReadOnly(style.transform).isIdentity;
          if (style.opacity !== '1' || !identity || style.visibility !== 'visible' || style.display === 'none'
            || rect.width <= 0 || rect.height <= 0 || animations.some(({ playState, pending }) => pending || playState === 'running')) return false;
          return { menuId, opacity: style.opacity, transform: style.transform, rect: rect.toJSON(), animations };
        }, {}, id);
        report.menuCaptureStates ||= [];
        report.menuCaptureStates.push({ label, ...await settled.jsonValue() });
        await settled.dispose();
      }
      await capture(page, label === 'Files' ? 'files-menu' : 'route-info-menu', true);
      await page.keyboard.press('Escape');
      await recordFocus('after-escape');
      await page.waitForSelector(`#${id}`, { hidden: true });
      await page.waitForFunction((menuId) => !document.getElementById(menuId), {}, id);
      await recordFocus('after-unmount');
      await page.waitForFunction((element) => document.activeElement === element, {}, trigger);
      assert.equal(await trigger.evaluate((element) => element.getAttribute('aria-expanded')), 'false', `${label} closes and restores trigger focus`);
    } catch (error) {
      await recordFocus('failure').catch((diagnosticError) => console.log(`MENU_FOCUS_DIAGNOSTIC_ERROR ${diagnosticError.message}`));
      throw error;
    }
  }
}

async function timelineHover(page) {
  const before = await media(page);
  await page.evaluate(() => document.fonts.ready);
  const slider = await page.waitForSelector(TIMELINE, { visible: true });
  await slider.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const box = await slider.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction((selector) => /^\d+:\d{2}(?::\d{2})? · \d{2}:\d{2}:\d{2}$/.test(
    document.querySelector(selector)?.lastElementChild?.textContent.trim() || ''), {}, TIMELINE);
  const hover = await slider.evaluate((element) => ({
    text: element.lastElementChild.textContent.trim(), ...element.lastElementChild.getBoundingClientRect().toJSON(),
  }));
  assert.ok(hover.width > 0 && hover.height > 0 && hover.x >= -1 && hover.right <= page.viewport().width + 1,
    'The timeline hover time is visible and fits the viewport');
  assert.ok(Math.abs((await media(page)).time - before.time) < 0.05, 'Timeline hover does not seek paused media');
  await capture(page, 'timeline-hover', true, async (phase) => {
    const state = await slider.evaluate((element) => {
      const badge = element.lastElementChild;
      const style = getComputedStyle(badge);
      return { text: badge.textContent.trim(), rect: badge.getBoundingClientRect().toJSON(),
        hovered: element.matches(':hover'), visibility: style.visibility, display: style.display, opacity: style.opacity,
        viewport: { width: innerWidth, height: innerHeight, clientWidth: document.documentElement.clientWidth },
        scroll: { x: scrollX, y: scrollY } };
    });
    report.timelineHoverCaptures ||= []; report.timelineHoverCaptures.push({ phase, ...state });
    assert.match(state.text, /^\d+:\d{2}(?::\d{2})? · \d{2}:\d{2}:\d{2}$/, `The hover badge exists ${phase} capture`);
    assert.ok(state.hovered && state.visibility === 'visible' && state.display !== 'none' && Number(state.opacity) > 0
      && state.rect.width > 0 && state.rect.height > 0 && state.rect.left >= 0 && state.rect.right <= state.viewport.width
      && state.rect.top >= 0 && state.rect.bottom <= state.viewport.height,
    `The actual pointer and complete visible hover badge survive ${phase} capture`);
  });
  await page.mouse.move(0, 0);
  await page.waitForFunction((selector) => !/ · \d{2}:\d{2}:\d{2}$/.test(
    document.querySelector(selector)?.lastElementChild?.textContent.trim() || ''), {}, TIMELINE);
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
  await page.waitForFunction((selector) => document.querySelector(selector)?.currentSrc, {}, VIDEO);
  // hls.js 1.7 retries fragment errors for up to 31 seconds before reporting fatal failure.
  const timeout = (await media(page)).currentSrc.startsWith('blob:') ? 45000 : 15000;
  await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')]
    .some((element) => /not uploaded|Unable to load video/.test(element.textContent)
      && [...element.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Retry')), { timeout });
  assert.equal((await media(page)).paused, true, 'A terminal error pauses the actual media element');
}

async function narrowErrorCard(page) {
  await page.$eval(VIDEO, (element) => element.scrollIntoView({ block: 'center' }));
  const bounds = await page.evaluate((selector) => {
    const retry = [...document.querySelectorAll('[role="status"] button')]
      .find((element) => element.textContent.trim() === 'Retry');
    const button = retry.getBoundingClientRect();
    return {
      viewport: innerWidth,
      video: document.querySelector(selector).getBoundingClientRect().toJSON(),
      card: retry.closest('[role="status"]').firstElementChild.getBoundingClientRect().toJSON(),
      button: button.toJSON(),
      reachable: document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2)?.closest('button') === retry,
    };
  }, VIDEO);
  for (const name of ['card', 'button']) {
    const rect = bounds[name];
    assert.ok(rect.width > 0 && rect.height > 0 && rect.left >= bounds.video.left - 1 && rect.right <= bounds.video.right + 1
      && rect.top >= bounds.video.top - 1 && rect.bottom <= bounds.video.bottom + 1,
    `The full error ${name} fits inside the video at ${bounds.viewport}px`);
  }
  assert.ok(bounds.reachable, 'The Retry button center reaches Retry without clipping or an obstructing layer');
  report.errorCards ||= []; report.errorCards.push(bounds);
}

async function capture(page, name, keepPointer = false, verifyState = null) {
  if (!keepPointer) await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await delay(250); // Preserve real CSS, allowing its 150 ms loading/opacity transition to finish.
  const filename = `${name}-${page.viewport().width}.png`;
  if (verifyState) await verifyState('before');
  // Keep interaction evidence in the actual viewport instead of CDP's captureBeyondViewport path.
  await page.screenshot({ path: resolve(output, filename), fullPage: !keepPointer, captureBeyondViewport: !keepPointer });
  report.screenshots.push(filename);
  if (verifyState) await verifyState('after');
}

async function scrollToTop(page) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function overlayHoverDiagnostics(overlay, point) {
  return overlay.evaluate((button, point) => {
    const span = button.firstElementChild;
    const describe = (element) => element && ({ tag: element.tagName, classes: element.className,
      label: element.getAttribute('aria-label'), text: element.textContent.trim().slice(0, 80) });
    const computed = (element) => {
      const style = getComputedStyle(element);
      return { opacity: style.opacity, display: style.display, visibility: style.visibility,
        pointerEvents: style.pointerEvents, zIndex: style.zIndex, transition: style.transition };
    };
    return {
      at: performance.now(), viewport: { width: innerWidth, height: innerHeight }, scroll: { x: scrollX, y: scrollY },
      mediaQueries: Object.fromEntries(['(hover: hover)', '(hover: none)', '(any-hover: hover)', '(pointer: fine)', '(pointer: coarse)']
        .map((query) => [query, matchMedia(query).matches])),
      button: { ...describe(button), connected: button.isConnected, hovered: button.matches(':hover'),
        focused: document.activeElement === button, focusVisible: button.matches(':focus-visible'),
        rect: button.getBoundingClientRect().toJSON(), computed: computed(button) },
      span: { ...describe(span), hovered: span.matches(':hover'), computed: computed(span),
        groupHoverSelectorMatches: span.matches(`.${CSS.escape('group-hover:opacity-100')}:is(:where(.group):hover *)`) },
      point, hit: describe(document.elementFromPoint(point.x, point.y)),
      hitStack: document.elementsFromPoint(point.x, point.y).slice(0, 6).map(describe),
    };
  }, point);
}

async function layout(page, state) {
  await scrollToTop(page);
  const measured = await page.evaluate(() => {
    const group = document.querySelector('[aria-label="Playback controls"]');
    const buttons = [...group.querySelectorAll('button[aria-label]')]
      .map((element) => ({ label: element.getAttribute('aria-label'), ...element.getBoundingClientRect().toJSON() }));
    const timestamp = group.querySelector('[aria-label="Selection playback time"]');
    return { width: innerWidth, height: innerHeight, scrollY, scrollWidth: document.documentElement.scrollWidth, buttons,
      group: group.getBoundingClientRect().toJSON(), timestamp: timestamp?.getBoundingClientRect().toJSON(),
      video: document.querySelector('.DriveView video').getBoundingClientRect().toJSON(),
      timeline: document.querySelector('[aria-label="Drive timeline"]').getBoundingClientRect().toJSON() };
  });
  report.layouts.push({ state, ...measured });
  assert.equal(measured.buttons.length, 5, 'All five playback controls remain available');
  assert.ok(measured.scrollWidth <= measured.width + 1, 'Page has no horizontal overflow');
  const centers = measured.buttons.map(({ y, height }) => y + height / 2);
  assert.ok(Math.max(...centers) - Math.min(...centers) <= 2, 'All playback controls share one row');
  assert.ok(measured.buttons.every(({ x, width }) => x >= -1 && x + width <= measured.width + 1), 'Every control fits horizontally');
  assert.ok(measured.buttons.every(({ width, height }) => width >= 44 && height >= 44), 'Playback controls retain 44px touch targets');
  assert.ok(measured.timeline.top >= measured.video.bottom - 1, 'The timeline sits beneath the video');
  assert.ok(measured.group.top >= measured.timeline.bottom - 1, 'The footer sits beneath the timeline');
  assert.ok(Math.abs(measured.group.width - measured.timeline.width) < 2, 'The footer spans the player timeline width');
  if (measured.width >= 1280) {
    assert.equal(measured.scrollY, 0, 'Desktop footer geometry is measured from the top of the page');
    assert.ok(measured.group.bottom <= measured.height, 'The complete desktop playback footer fits inside the viewport');
  }
  if (measured.width <= 390) {
    assert.ok(measured.timestamp, 'Playback timestamp exists');
    assert.ok(measured.timestamp.bottom <= Math.min(...measured.buttons.map(({ y }) => y)) + 1,
      'Narrow-layout timestamp is above the transport row');
  }
}

async function mapCapture(page, name, videoState = 'paused') {
  const videoElement = await page.$(VIDEO);
  const before = await media(page);
  if (page.viewport().width < 1536) {
    await textButton(page, 'Map');
    assert.equal(await page.$(VIDEO_TOGGLE), null, 'Map view removes the video overlay control');
  }
  await page.waitForSelector('.mapboxgl-canvas', { visible: true });
  const canvas = await page.$('.mapboxgl-canvas');
  await canvas.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  if (page.viewport().width < 1536) {
    const geometry = await canvas.evaluate((element) => {
      const video = document.querySelector('.DriveView video');
      const wrapper = video.parentElement.nextElementSibling;
      const map = element.closest('.mapboxgl-map');
      return {
        viewport: { width: innerWidth, height: innerHeight },
        video: video.getBoundingClientRect().toJSON(),
        canvas: element.getBoundingClientRect().toJSON(),
        map: map.getBoundingClientRect().toJSON(),
        mapMinHeight: getComputedStyle(map).minHeight,
        wrapper: wrapper.getBoundingClientRect().toJSON(),
        wrapperContainsMap: wrapper.contains(element),
        wrapperVisibility: getComputedStyle(wrapper).visibility,
        wrapperOverflow: getComputedStyle(wrapper).overflow,
        videoOverlayCount: video.parentElement.querySelectorAll('[role="status"]').length,
        videoControlCount: video.parentElement.querySelectorAll('button').length,
        mapReceivesPointer: wrapper.contains(document.elementFromPoint(
          element.getBoundingClientRect().x + element.getBoundingClientRect().width / 2,
          element.getBoundingClientRect().y + element.getBoundingClientRect().height / 2)),
      };
    });
    report.mapGeometry ||= []; report.mapGeometry.push({ videoState, ...geometry });
    assert.equal(geometry.videoOverlayCount, 0, 'Video loading and errors do not cover the selected map');
    assert.equal(geometry.videoControlCount, 0, 'The selected map has no hidden video controls in the tab order');
    assert.equal(geometry.mapReceivesPointer, true, 'The visible map receives pointer input at its center');
    assert.ok(geometry.wrapperContainsMap && geometry.wrapperVisibility === 'visible', 'The measured wrapper contains the visible map');
    for (const name of ['canvas', 'map']) {
      assert.ok(geometry[name].height > 0 && Math.abs(geometry[name].height - geometry.wrapper.height) <= 1,
        `The narrow ${name} height matches its visible wrapper without inherited minimum-height clipping`);
    }
  }
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
  assert.equal(after.id, before.id, 'Map switch preserves the video identity marker');
  assert.equal(await videoElement.evaluate((element, selector) => element.isConnected && element === document.querySelector(selector), VIDEO),
    true, 'Map switch preserves the actual video element even before metadata');
  assert.ok(Math.abs(after.time - before.time) < 0.1, 'Paused map switch preserves media time');
  if (videoState !== 'paused') assert.equal(after.frames, before.frames, 'Map switching does not imply decoded playback during loading or failure');
  await capture(page, name);
  if (page.viewport().width < 1536) {
    await textButton(page, 'Video');
    if (videoState === 'failed') await errorVisible(page);
    else if (videoState === 'loading') await page.waitForSelector('[aria-label="Loading video"]', { visible: true });
    else await page.waitForSelector('button[aria-label="Play video"]', { visible: true });
    assert.equal(await videoElement.evaluate((element, selector) => element.isConnected && element === document.querySelector(selector), VIDEO),
      true, 'Returning to Video preserves the actual media element');
  }
}

async function main() {
  await mkdir(output, { recursive: true });
  report.sha = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
  report.candidate = process.env.QA_CANDIDATE_SHA;
  if (report.candidate) {
    await execute('git', ['diff', '--exit-code', report.candidate, '--', '.',
      ':!scripts/qa769-modern.mjs', ':!.github/workflows/qa769-modern.yaml']);
  }
  const missing = new Map();
  for (const name of ['missing-first', 'missing-middle']) {
    const manifest = await readFile(resolve(fixtures, `${name}.m3u8`), 'utf8');
    const uri = manifest.split('\n').find((line) => line.startsWith('https:'));
    assert.ok(uri, `${name} has a real missing-fragment URL`);
    missing.set(uri, await readFile(resolve(fixtures, `${name === 'missing-first' ? 0 : 1}/qcamera.ts`)));
  }
  const completeManifest = await readFile(resolve(fixtures, 'complete.m3u8'), 'utf8');
  const fixtureAssets = new Map();
  for (const segment of [0, 1, 2]) {
    for (const file of ['qcamera.ts', 'coords.json', 'events.json', 'sprite.jpg']) {
      fixtureAssets.set(`/demo-video/${segment}/${file}`, await readFile(resolve(fixtures, `${segment}/${file}`)));
    }
  }
  report.fixtureSha256 = Object.fromEntries([['complete.m3u8', completeManifest], ...fixtureAssets]
    .map(([name, content]) => [name, createHash('sha256').update(content).digest('hex')]));
  await build({ mode: 'production', build: { outDir: resolve(output, 'app'), sourcemap: false } });
  const server = await preview({ configFile: false, build: { outDir: resolve(output, 'app') },
    preview: { host: '127.0.0.1', port: 0, strictPort: true } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome',
    headless, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-background-networking', '--force-color-profile=srgb', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] })
    .catch(async (error) => { await server.close(); throw error; });
  report.browser = await browser.version();

  async function scenario(name, run, { forceMse = false, comparison = false } = {}) {
    if (caseFilter && name !== caseFilter) return;
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const result = { name, status: 'running', forceMse, comparison, requests: [], console: [], pageErrors: [], held: [], healed: new Set() };
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
      const start = Date.parse('2026-10-09T12:00:00Z');
      const route = { fullname: PUBLIC_ROUTE, dongle_id: PUBLIC_ROUTE.split('|')[0], url: `${origin}/demo-video`,
        create_time: start / 1000, start_time: new Date(start).toISOString().slice(0, 19),
        end_time: new Date(start + 180000).toISOString().slice(0, 19),
        start_time_utc_millis: start, end_time_utc_millis: start + 180000,
        segment_numbers: [0, 1, 2], segment_start_times: [0, 1, 2].map((i) => start + i * 60000),
        segment_end_times: [1, 2, 3].map((i) => start + i * 60000), maxqlog: 2, procqlog: 2,
        distance: 0.105, is_public: true, start_lat: 32.75, start_lng: -117.195, end_lat: 32.75, end_lng: -117.1932,
        videoStartOffset: 0,
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
          const fixturePath = url.pathname.startsWith(`${PUBLIC_ASSET_PREFIX}/`)
            ? `/demo-video/${url.pathname.slice(PUBLIC_ASSET_PREFIX.length + 1)}` : url.pathname;
          if (request.method() === 'OPTIONS') await respond(request, '', 204, 'text/plain');
          else if (comparison && (url.pathname.endsWith('.m3u8'))) {
            // Same healthy bytes for the existing route8 on all revisions. No app source or media clocks are replaced.
            const absoluteManifest = completeManifest.replace(/^(\d+\/qcamera\.ts)$/gm, `${origin}/demo-video/$1`);
            await respond(request, absoluteManifest, 200, 'application/vnd.apple.mpegurl');
          } else if ((comparison || fixturePath !== url.pathname) && fixtureAssets.has(fixturePath)) {
            const type = fixturePath.endsWith('.ts') ? 'video/mp2t' : fixturePath.endsWith('.jpg') ? 'image/jpeg' : 'application/json';
            await respond(request, fixtureAssets.get(fixturePath), 200, type);
          } else if (comparison && url.hostname === 'cdn.jsdelivr.net' && /^\/npm\/hls\.js@[^/]+\/dist\/hls(?:\.min)?\.js$/.test(url.pathname)) {
            result.requests.push({ url: url.href, realHlsCdn: true });
            await request.continue();
          }
          else if (missing.has(url.href)) {
            result.requests.push({ at: Date.now(), url: url.href, type: request.resourceType(),
              repaired: result.healed.has(url.href), held: Boolean(result.hold) });
            if (result.hold) { result.held.push(request); return; }
            await respond(request, result.healed.has(url.href) ? missing.get(url.href) : 'BlobNotFound',
              result.healed.has(url.href) ? 200 : 404, result.healed.has(url.href) ? 'video/mp2t' : 'text/plain');
          } else if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) await request.continue();
          else if (url.hostname === 'api.comma.ai' && url.pathname === '/v1/devices/5beb9b58bd12b691/routes_segments') await respond(request, [route]);
          else if (url.hostname === 'api.comma.ai' && decodeURIComponent(url.pathname) === `/v1/route/${PUBLIC_ROUTE}/files`) {
            await respond(request, { qcameras: [0, 1, 2].map((segment) => `${origin}${PUBLIC_ASSET_PREFIX}/${segment}/qcamera.ts`) });
          }
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
        await click(page, comparison ? '.DriveEntry[href="/deadbeefdeadbeef/00000000--0000000008"]' : routeLink(kind));
        await page.waitForSelector(VIDEO);
      };
      await page.goto(`${origin}/demo`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(comparison ? '.DriveEntry[href="/deadbeefdeadbeef/00000000--0000000008"]' : routeLink('complete'));
      await run({ page, result, openRoute, respond });
      assert.deepEqual(result.pageErrors, [], 'No uncaught application errors');
      result.status = 'passed';
    } catch (error) {
      result.status = 'failed'; result.error = error.stack;
      await capture(page, `${name}-failure`, true).catch(() => {});
    } finally {
      result.mediaEvents = await page.evaluate(() => globalThis.qaEvents).catch(() => []);
      if (result.startup) result.startup.presentedFrames = await page.evaluate(() => globalThis.qaStartupFrames || []).catch(() => []);
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
    await scenario('comparison-healthy-player', async ({ page, result, openRoute }) => {
      result.scope = 'Healthy capture only: common demo route8, identical 180s H.264/AAC media and metadata. No recovery or new-design assertions on older revisions.';
      await openRoute('complete'); await playing(page);
      await click(page, 'button[aria-label="Pause"]');
      await page.waitForFunction((selector) => document.querySelector(selector)?.paused, {}, VIDEO);
      const slider = await page.waitForSelector(TIMELINE, { visible: true });
      await slider.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      const box = await slider.boundingBox();
      await page.mouse.click(box.x + box.width / 4, box.y + box.height / 2);
      await page.waitForFunction((selector) => {
        const video = document.querySelector(selector);
        return video?.paused && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - 45) < 0.8;
      }, {}, VIDEO);
      assert.ok((await media(page)).frames > 0, 'The comparison frame comes from real decoded video');
      assert.ok(Math.abs((await media(page)).duration - 180) < 0.5, 'All comparison builds decode the same three-minute media');
      await page.waitForSelector('.DriveView .thumbnailImage.images');
      for (const viewport of viewports) {
        await page.setViewport(viewport); await delay(150);
        await scrollToTop(page);
        await capture(page, 'comparison-video');
        const metrics = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
          video: document.querySelector('.DriveView video').getBoundingClientRect().toJSON(),
          timeline: document.querySelector('[aria-label="Drive timeline"]').getBoundingClientRect().toJSON() }));
        result.layouts ||= []; result.layouts.push(metrics);
      }
      result.capturedMedia = await media(page);
    }, { comparison: true });

    if (!captureOnly) {
      await scenario('controls-and-responsive', async ({ page, result, openRoute }) => {
        result.inputCapabilities = await page.evaluate(() => Object.fromEntries(
          ['(hover: hover)', '(hover: none)', '(any-hover: hover)', '(pointer: fine)', '(pointer: coarse)']
            .map((query) => [query, matchMedia(query).matches])));
        console.log(`DESKTOP_INPUT_CAPABILITIES ${JSON.stringify(result.inputCapabilities)}`);
        assert.ok(result.inputCapabilities['(hover: hover)'] && result.inputCapabilities['(pointer: fine)'],
          'The desktop interaction scenario requires a real hover-capable fine pointer');
        await openRoute('complete'); await playing(page); await pause(page);
        const paused = await media(page); await delay(400);
        assert.ok(Math.abs((await media(page)).time - paused.time) < 0.05, 'Pause stops the actual clock');
        await click(page, 'button[aria-label="Play video"]'); await playing(page);
        await click(page, 'button[aria-label="Pause video"]'); await pause(page);
        await page.focus('button[aria-label="Play video"]'); await page.keyboard.press('Enter'); await playing(page);
        await page.keyboard.press('Space'); await pause(page);
        const target = await seek(page, 45); await settledAt(page, target);
        await page.focus(TIMELINE); await page.keyboard.press('ArrowRight'); await settledAt(page, target + 10);
        await page.keyboard.press('ArrowLeft'); await settledAt(page, target);
        await page.keyboard.press('ArrowRight'); await settledAt(page, target + 10);
        await click(page, 'button[aria-label="Jump back 10 seconds"]'); await settledAt(page, target);
        await click(page, 'button[aria-label="Jump forward 10 seconds"]'); await settledAt(page, target + 10);
        report.elapsedTime = await elapsedTime(page);
        await speedKeyboard(page);
        await speed(page, 4);
        assert.equal((await media(page)).paused, true, 'Changing speed keeps paused video paused');
        await click(page, 'button[aria-label="Unmute"]'); assert.equal((await media(page)).muted, false);
        await click(page, 'button[aria-label="Play"]'); await playing(page);
        assert.equal((await media(page)).rate, 4, 'Native media uses selected 4x rate');
        assert.ok((await media(page)).audioBytes > 0, 'Chrome actually decodes the AAC track');
        await click(page, 'button[aria-label="Mute"]'); assert.equal((await media(page)).muted, true);
        const active = await media(page); await textButton(page, 'Map'); await playing(page);
        assert.equal((await media(page)).id, active.id, 'Playing Map switch preserves the video element');
        assert.equal(await page.$(VIDEO_TOGGLE), null, 'Playing Map view removes the video overlay control');
        await textButton(page, 'Video'); await playing(page);
        const overlay = await page.waitForSelector('button[aria-label="Pause video"]', { visible: true });
        await overlay.hover();
        const hoverPoint = await overlay.clickablePoint();
        result.overlayHover = { beforeWait: await overlayHoverDiagnostics(overlay, hoverPoint) };
        console.log(`OVERLAY_HOVER_BEFORE_WAIT ${JSON.stringify(result.overlayHover.beforeWait)}`);
        await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
        try {
          await page.waitForFunction((element) => getComputedStyle(element.firstElementChild).opacity === '1', {}, overlay);
        } catch (error) {
          result.overlayHover.onFailure = await overlayHoverDiagnostics(overlay, hoverPoint)
            .catch((diagnosticError) => ({ error: diagnosticError.message }));
          console.log(`OVERLAY_HOVER_FAILURE ${JSON.stringify(result.overlayHover.onFailure)}`);
          throw error;
        }
        assert.equal((await media(page)).id, active.id, 'Returning to Video restores the overlay on the same playing media');
        await capture(page, 'video-hover', true, async (phase) => {
          assert.equal(await overlay.evaluate((element) => getComputedStyle(element.firstElementChild).opacity), '1',
            `The playing video hover control remains visible ${phase} capture`);
        });
        await pause(page);
        await page.waitForSelector('.DriveView .thumbnailImage.images');
        for (const viewport of viewports) {
          await page.setViewport(viewport); await delay(150);
          await scrollToTop(page);
          await capture(page, 'video'); await layout(page, 'video'); await elapsedTime(page);
          await mapCapture(page, 'map'); await timelineHover(page);
          if (viewport.width === 390) {
            await speedKeyboard(page); await adjacentMenus(page);
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
        assert.equal(await page.$('button[aria-label="Play video"], button[aria-label="Pause video"]'), null,
          'Video play overlay is absent while an error needs attention');
        for (const viewport of viewports) {
          await page.setViewport(viewport); await scrollToTop(page);
          await capture(page, 'missing-first-error'); await layout(page, 'error');
          if (viewport.width <= 390) await narrowErrorCard(page);
        }
        await page.setViewport(viewports[1]);
        await mapCapture(page, 'map-with-error', 'failed');
        await pause(page); const later = await seek(page, 125); await settledAt(page, later);
        await page.focus(TIMELINE); await page.keyboard.press('Home'); await errorVisible(page);
        const count = result.requests.length;
        result.healed.add([...missing.keys()][0]); await textButton(page, 'Retry'); await settledAt(page, 0);
        assert.ok(result.requests.length > count && result.requests.at(-1).repaired, 'Retry requests the repaired fragment');
        await click(page, 'button[aria-label="Play"]'); await playing(page);
      });

      await scenario('natural-chrome-middle-gap-recovery', async ({ page, result, openRoute }) => {
        await openRoute('middle'); await playing(page); await pause(page);
        await seek(page, 75); await errorVisible(page); await capture(page, 'natural-middle-gap');
        const count = result.requests.length; await textButton(page, 'Retry');
        await eventually(() => result.requests.length > count, 'Natural-browser Retry reattempts the missing middle fragment');
        await errorVisible(page);
        await settledAt(page, await seek(page, 125)); await click(page, 'button[aria-label="Play"]'); await playing(page);
        await capture(page, 'natural-middle-recovered');
      });

      await scenario('forced-mse-prefetch-and-loops', async ({ page, result, openRoute }) => {
        await openRoute('middle'); await playing(page); await pause(page);
        const transport = await media(page);
        assert.ok(transport.currentSrc.startsWith('blob:') && transport.hlsModuleLoaded, 'This scenario actually exercises hls.js/MSE');
        // Trigger the actual request near the buffered end, not an assumed paused prefetch threshold.
        await seek(page, 55); await click(page, 'button[aria-label="Play"]');
        await eventually(() => result.requests.length, 'Real HLS prefetch encounters missing middle fragment');
        await pause(page); result.prefetchMedia = await media(page);
        await delay(300);
        const slider = await page.$(TIMELINE); await slider.evaluate((element) => element.scrollIntoView({ block: 'center' }));
        const box = await slider.boundingBox();
        await page.mouse.move(box.x + box.width / 180, box.y + box.height / 2); await page.mouse.down();
        await page.mouse.move(box.x + box.width * 15 / 180, box.y + box.height / 2, { steps: 8 });
        await page.waitForFunction((selector) => /^Loop \d+:\d{2} – \d+:\d{2}$/.test(
          document.querySelector(selector)?.lastElementChild?.textContent.trim() || ''), {}, TIMELINE);
        await capture(page, 'loop-selection', true); await page.mouse.up();
        await page.waitForFunction((selector) => Number(document.querySelector(selector).getAttribute('aria-valuemax')) < 16, {}, TIMELINE);
        const bounds = await page.$eval(TIMELINE, (element) => ({
          start: Number(element.getAttribute('aria-valuemin')), end: Number(element.getAttribute('aria-valuemax')),
        }));
        assert.ok(bounds.start > 0 && bounds.start < 2 && bounds.end > 14, 'Pointer drag selects the intended valid loop');
        await speed(page, 8);
        await elapsedTime(page);
        const eventStart = await page.evaluate(() => globalThis.qaEvents.length);
        await click(page, 'button[aria-label="Play"]'); await playing(page); await delay(2500); await pause(page);
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
        await settledAt(page, await seek(page, 125)); await click(page, 'button[aria-label="Play"]'); await playing(page);
      }, { forceMse: true });

      await scenario('startup-seek-and-route-reset', async ({ page, result, openRoute, respond }) => {
        result.startup = { requests: [], released: [], cancelled: [] };
        await openRoute('complete'); await playing(page); await speed(page, 8);
        // Natural progress keeps seekRequest null, so its reset cannot mask a stale mount offset.
        await page.waitForFunction((selector) => document.querySelector(selector).currentTime > 65, {}, VIDEO);
        await pause(page);
        result.startup.previousRoute = await media(page);
        assert.ok(result.startup.previousRoute.time > 65 && result.startup.previousRoute.time < 120,
          'The previous route has naturally advanced into its second segment');
        const oldVideo = await page.$(VIDEO);
        await click(page, '.DriveView [aria-label="Close"]');
        assert.equal(await oldVideo.evaluate((element) => element.isConnected), false, 'Closing disconnects the previous media');
        page.on('request', (request) => {
          if (request.method() === 'GET' && new URL(request.url()).pathname.endsWith('/qcamera.ts')) {
            result.startup.requests.push({ at: Date.now(), url: request.url() });
          }
        });
        const firstUrl = [...missing.keys()].find((url) => new URL(url).pathname.endsWith('/0/qcamera.ts'));
        assert.ok(firstUrl, 'The existing missing-first fixture provides segment zero');
        result.hold = true; await openRoute('first');
        await eventually(() => result.held.length, 'The new route requests its held first fragment');
        assert.equal(result.startup.requests[0]?.url, firstUrl, 'The first requested fragment belongs to the new route start, not the old clock');
        await page.waitForSelector('[aria-label="Loading video"]', { visible: true });
        result.startup.initial = await media(page);
        assert.equal(result.startup.initial.ready, 0, 'Initial media is held before metadata');
        assert.equal(result.startup.initial.frames, 0, 'No old-route frame is decoded by the new video');
        assert.equal(await page.$eval(TIMELINE, (element) => Number(element.getAttribute('aria-valuenow'))), 0,
          'The new timeline resets before any seek command');
        const video = await page.$(VIDEO);
        await video.evaluate((element) => {
          if (typeof element.requestVideoFrameCallback !== 'function') throw new Error('Presented-frame timestamps are required');
          globalThis.qaStartupFrames = [];
          const observe = (at, frame) => {
            globalThis.qaStartupFrames.push({ at, mediaTime: frame.mediaTime, presentedFrames: frame.presentedFrames,
              id: element.dataset.qaVideo, currentTime: element.currentTime, paused: element.paused });
            if (element.isConnected) element.requestVideoFrameCallback(observe);
          };
          element.requestVideoFrameCallback(observe);
        });
        await seek(page, 15);
        const target = await seek(page, 25);
        await pause(page);
        result.startup.target = target;
        result.startup.pending = await media(page);
        assert.equal(result.startup.pending.ready, 0, 'Both seek commands occur before metadata');
        assert.equal(result.startup.pending.frames, 0, 'Pending seek intent does not imply a decoded frame');
        assert.ok(Math.abs(await page.$eval(TIMELINE, (element) => Number(element.getAttribute('aria-valuenow'))) - target) < 0.01,
          'The timeline retains the latest pending seek');
        await capture(page, 'startup-seek-loading', true);
        const releasedAt = await page.evaluate(() => performance.now());
        result.healed.add(firstUrl); result.hold = false;
        for (const request of result.held.splice(0)) {
          if (request.failure()?.errorText === 'net::ERR_ABORTED') {
            result.startup.cancelled.push(request.url());
            continue;
          }
          try {
            await respond(request, missing.get(request.url()), 200, 'video/mp2t');
            result.startup.released.push(request.url());
          } catch (error) {
            if (request.failure()?.errorText !== 'net::ERR_ABORTED') throw error;
            result.startup.cancelled.push(request.url());
          }
        }
        await settledAt(page, target);
        await page.waitForFunction(({ target, releasedAt }) => {
          const frame = globalThis.qaStartupFrames.at(-1);
          return frame && frame.at >= releasedAt && Math.abs(frame.mediaTime - target) < 0.6;
        }, {}, { target, releasedAt });
        assert.equal(await video.evaluate((element, selector) => element === document.querySelector(selector), VIDEO), true,
          'Releasing delayed media preserves the same video element');
        result.startup.settled = await media(page);
        assert.notEqual(result.startup.settled.id, result.startup.previousRoute.id, 'The new route owns a distinct media element');
        await delay(400);
        const stopped = await media(page);
        assert.equal(stopped.paused, true, 'Completing a delayed seek preserves the requested pause');
        assert.ok(Math.abs(stopped.time - result.startup.settled.time) < 0.05, 'The paused media clock stays stopped');
        await capture(page, 'startup-seek-paused', true);
        await click(page, 'button[aria-label="Play"]'); await playing(page);
        result.startup.resumed = await media(page);
      });

      await scenario('navigation-cancellation-and-loading', async ({ page, result, openRoute, respond }) => {
        result.hold = true; await openRoute('first');
        await eventually(() => result.held.length, 'Old route has an in-flight real fragment request');
        await page.waitForSelector('[aria-label="Loading video"]', { visible: true });
        const loadingTransport = await page.waitForSelector('button[aria-label="Pause video"]', { visible: true });
        await loadingTransport.evaluate((element) => element.scrollIntoView({ block: 'center' }));
        assert.ok(await loadingTransport.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return !element.disabled && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button') === element;
        }), 'The video transport remains reachable through the loading indicator');
        const loadingBefore = await media(page);
        await loadingTransport.focus(); await page.keyboard.press('Enter');
        await page.waitForSelector('button[aria-label="Play video"]');
        assert.equal((await media(page)).paused, true, 'The keyboard can pause while media is loading');
        await page.keyboard.press('Space');
        await page.waitForSelector('button[aria-label="Pause video"]');
        assert.ok(await loadingTransport.evaluate((element) => element.isConnected && document.activeElement === element),
          'The loading transport remains mounted and focused across pause and resume commands');
        await page.waitForSelector('[aria-label="Loading video"]', { visible: true });
        const loadingAfter = await media(page);
        assert.equal(loadingAfter.frames, 0, 'A play command while waiting for the first fragment does not imply decoded playback');
        assert.ok(Math.abs(loadingAfter.time - loadingBefore.time) < 0.05, 'Loading commands do not advance the media clock');
        result.loadingMedia = { before: loadingBefore, after: loadingAfter };
        await capture(page, 'loading');
        const placement = await page.evaluate((selector) => {
          const video = document.querySelector(selector).getBoundingClientRect();
          const spinner = document.querySelector('[aria-label="Loading video"]').getBoundingClientRect();
          return { x: Math.abs(video.x + video.width / 2 - spinner.x - spinner.width / 2),
            y: Math.abs(video.y + video.height / 2 - spinner.y - spinner.height / 2) };
        }, VIDEO);
        assert.ok(placement.x < 2 && placement.y < 2, 'Loading indicator is centered in the video');
        await mapCapture(page, 'map-while-loading', 'loading');
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
    }
  } finally {
    await browser.close(); await server.close();
  }
  report.finished = new Date().toISOString();
  assert.ok(report.cases.length > 0, `No browser QA scenarios matched QA769_CASE=${caseFilter}`);
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
