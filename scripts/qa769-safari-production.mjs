/*
 * Diagnostic stock-Safari comparison of pinned synthetic and public qcamera
 * media. Run only in an ephemeral, pre-enabled GitHub-hosted macOS job:
 *   QA_CANDIDATE_SHA=2d3bca154c33b09416f9826fad113863adb25946
 *   QA769_OUTPUT=/results/safari-production
 *   node scripts/qa769-safari-production.mjs
 * The public helper performs bounded, hash-pinned retrieval only after the
 * normal driver/image preflight. TS bytes stay in memory. FFmpeg receives
 * those bytes through stdin and exports independent reference PNGs on stdout.
 * No Safari preferences, automation settings, or profiles are changed. Every
 * owned WebDriver session is deleted; the driver is left to normal job cleanup.
 */
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadPublicQcameraReference } from './qa769-public-qcamera.mjs';

const PINNED_SOURCE = '2d3bca154c33b09416f9826fad113863adb25946';
const PUBLIC_HELPER_SHA256 = '8a3a188acf8fdf435ae60683856e3ca474a838abb351f0a31750217b1ca3b875';
const ORIGINAL_HASHES = {
  'complete.m3u8': '3b9c3967df955376b969409358c35d1840f5728ee66a842d257039c688cd3fda',
  '0/qcamera.ts': 'd2616e37b45e2c0628af3545fa12fcb2db8945cfbf3799f882c97ffe4636c61b',
  '1/qcamera.ts': 'd19d3985238becc0d20b5a7eec47f118ab22df856661844342b9d242ea837f48',
  '2/qcamera.ts': 'e2c74fb5ea4beaaa778d3eae4b0294023b8b01beb28c8a20d1d0187bbb07c3e8',
};
const execute = promisify(execFile);
const output = resolve(process.env.QA769_OUTPUT || 'qa769-safari-production-results');
const delay = (ms) => new Promise((accept) => setTimeout(accept, ms));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const order = ['original-synthetic-A1', 'public-production-B1', 'public-production-B2', 'original-synthetic-A2'];
const report = {
  started: new Date().toISOString(), status: 'preflight', acceptanceRun: false, collectionComplete: false,
  purpose: 'Compare pinned original synthetic media with unchanged public production qcamera bytes in stock desktop Safari native HLS, without video-frame callbacks.',
  controls: 'Two availability blocks in order: complete, then missing-middle. Each block uses original-synthetic A1, public-production B1, public-production B2, original-synthetic A2; all seek to 125s through native HLS. Every case gets a fresh WebDriver SESSION and unique local URLs. The Safari process is not restarted between sessions. No emulation, capability spoofing, application code, reloads, or playback retries.',
  oracle: 'Startup/resume requires >=2s without a seek or invalid state, >1.7s clock advancement, and increases in totalVideoFrames minus droppedVideoFrames both from the initial baseline and after a late baseline at >=1.5s. A late interval must span >=400ms and >0.3s of media time. Paused targets retain six samples over >=1s before the first screenshot. Synthetic screenshots require burned-timestamp review; production screenshots require independent comparison with offline-decoded reference frames. Clock/quality success does not establish a correct presented frame.',
  screenshotOrder: 'No screenshot, canvas read, or video-frame callback occurs before startup and the first paused-target measurements. Resume measurements occur after the paused screenshot, which may affect the renderer path.',
  nativeScope: 'Normal desktop Safari only. This is not physical iOS, iPhone emulation, Playwright WebKit, or an application acceptance claim.',
  missingMiddlePolicy: 'Each variant uses its own complete manifest, unchanged between availability blocks. Only 1/qcamera.ts returns an actual HTTP 404 in missing-middle cases; segment 2 remains available. No GAP or DISCONTINUITY tag is added. The complete block precedes the missing block; no repair action is tested.',
  fixtureLimits: 'Production media is video only and has no burned timestamp. It changes several encoding properties together and cannot isolate their individual effects or validate audio. The public source is localized to its first three segments without re-encoding or saving TS files.',
  driverLifecycle: 'Start only the pre-enabled system driver on an ephemeral GitHub-hosted runner. Use loopback HTTP; DELETE every owned session. Do not kill the driver process. Its file-backed logs and unref allow Node to exit; normal job cleanup removes the service.',
  references: [
    'https://developer.apple.com/documentation/webkit/testing-with-webdriver-in-safari',
    'https://developer.apple.com/documentation/webkit/about-webdriver-for-safari',
    'https://github.com/actions/runner-images/blob/9312c564c4df0b842ce00a6c202dccb519b8dfdd/images/macos/macos-15-arm64-Readme.md',
    'https://github.com/actions/runner-images/blob/9312c564c4df0b842ce00a6c202dccb519b8dfdd/images/macos/scripts/build/install-safari.sh',
    'https://docs.github.com/en/actions/reference/workflows-and-actions/variables',
    'https://github.com/WebKit/WebKit/blob/56453fdfe0b0ca6258c23e6453b34f70b885d13f/Source/WebCore/platform/graphics/avfoundation/AudioVideoRendererAVFObjC.mm#L1503-L1537',
    'https://github.com/WebKit/WebKit/blob/56453fdfe0b0ca6258c23e6453b34f70b885d13f/Source/WebCore/platform/graphics/avfoundation/objc/MediaPlayerPrivateAVFoundationObjC.mm#L2761-L2807',
  ],
  plan: ['complete', 'missing-middle'].flatMap((availability) => order.map((arm) => ({
    name: `native-${availability}-${arm}-target-125`, transport: 'native', target: 125,
    variant: arm.startsWith('public-production') ? 'public-production' : 'original-synthetic', availability,
  }))),
  environment: {
    platform: process.platform, arch: process.arch, node: process.version,
    githubActions: process.env.GITHUB_ACTIONS, runnerEnvironment: process.env.RUNNER_ENVIRONMENT,
    runnerOS: process.env.RUNNER_OS, runnerArch: process.env.RUNNER_ARCH,
    imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion,
  },
  cases: [], strayHttpRequests: [],
};
const save = () => writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));

// Injected before the transport starts. These listeners never request frame
// callbacks or read pixels, and perform no media writes.
function observe() {
  globalThis.qaEvents = []; globalThis.qaPlayErrors = []; globalThis.qaHlsErrors = [];
  globalThis.qaPageErrors = []; globalThis.qaProbe = null; globalThis.qaSetup = 'initializing';
  addEventListener('error', (event) => globalThis.qaPageErrors.push({ message: event.message, file: event.filename, line: event.lineno }));
  addEventListener('unhandledrejection', (event) => globalThis.qaPageErrors.push({ message: String(event.reason) }));
  for (const type of ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'pause', 'seeking', 'seeked', 'waiting', 'ended', 'error', 'timeupdate']) {
    document.addEventListener(type, ({ target: video }) => {
      if (!(video instanceof HTMLVideoElement)) return;
      const quality = video.getVideoPlaybackQuality?.();
      globalThis.qaEvents.push({ type, at: performance.now(), time: video.currentTime, paused: video.paused,
        seeking: video.seeking, ready: video.readyState, frames: quality?.totalVideoFrames ?? null,
        droppedFrames: quality?.droppedVideoFrames ?? null });
    }, true);
  }
}

function mediaSample() {
  const video = document.querySelector('video');
  if (!video) return null;
  const quality = video.getVideoPlaybackQuality();
  return {
    at: performance.now(), time: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null,
    paused: video.paused, seeking: video.seeking, ready: video.readyState, network: video.networkState,
    width: video.videoWidth, height: video.videoHeight, frames: quality.totalVideoFrames, droppedFrames: quality.droppedVideoFrames,
    buffered: Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]),
    seekable: Array.from({ length: video.seekable.length }, (_, i) => [video.seekable.start(i), video.seekable.end(i)]),
    src: video.currentSrc, error: video.error && { code: video.error.code, message: video.error.message },
    playbackRate: video.playbackRate, muted: video.muted, visibility: document.visibilityState, focused: document.hasFocus(),
  };
}

// Same strict clock/quality test as qa769-reference.mjs; no RVFC fallback.
function sustainedProbe() {
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
}

function referenceHtml(plan) {
  return Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><title>Playback reference</title>
    <style>body{margin:16px;font:16px sans-serif;color:#ddd;background:#16181a}video{display:block;width:320px;height:200px;max-width:100%;background:black}p{max-width:640px}</style>
    </head><body><h1>Playback reference</h1><p>${plan.name}</p><video controls playsinline muted preload="auto"></video>
    <p>${plan.variant === 'public-production' ? 'Pinned public production qcamera; no burned timestamp' : 'Original synthetic media; burned timestamp'}; ${plan.availability}. No Connect application code.</p>
    <script>(${observe.toString()})();</script>
    <script>
      try {
        const video = document.querySelector('video');
        video.addEventListener('loadedmetadata', () => { if (video.currentTime !== 0) video.currentTime = 0;
          video.play().catch(error => globalThis.qaPlayErrors.push({ name: error.name, message: error.message }));
        }, { once: true });
        video.src = 'complete.m3u8'; video.load(); video.currentTime = 0;
        globalThis.qaSetup = 'ready';
      } catch (error) { globalThis.qaSetup = 'failed'; globalThis.qaPageErrors.push({ name: error.name, message: error.message }); }
    </script></body></html>`);
}

async function command(origin, method, path, body, timeout = 30000) {
  const response = await fetch(`${origin}${path}`, {
    method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json; charset=utf-8' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout), redirect: 'error',
  });
  const payload = await response.json();
  if (!response.ok || payload.value?.error) {
    throw new Error(`WebDriver ${method} ${path}: ${payload.value?.error || response.status}: ${payload.value?.message || 'Unknown response'}`);
  }
  return payload.value;
}

function sessionClient(origin, id) {
  const path = `/session/${encodeURIComponent(id)}`;
  return {
    navigate: (url) => command(origin, 'POST', `${path}/url`, { url }),
    evaluate: (fn, ...args) => command(origin, 'POST', `${path}/execute/sync`, { script: `return (${fn.toString()})(...arguments);`, args }),
    screenshot: () => command(origin, 'GET', `${path}/screenshot`),
    close: () => command(origin, 'DELETE', path),
  };
}

async function waitUntil(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    if (await predicate()) return true;
    await delay(100);
  } while (Date.now() < deadline);
  return false;
}

async function sustained(client) {
  await client.evaluate(() => { globalThis.qaProbe = null; });
  const passed = await waitUntil(() => client.evaluate(sustainedProbe));
  return { passed, ...(passed ? {} : { error: 'Strict clock and late non-dropped-frame progress did not hold within 15000ms' }),
    baseline: await client.evaluate(() => globalThis.qaProbe), after: await client.evaluate(mediaSample) };
}

async function capture(client, result, phase) {
  assert.equal(result.firstPausedSamplesRecorded, true, 'Screenshots must follow the first paused-target measurements');
  const filename = `${result.name}-${phase}.png`;
  const bytes = Buffer.from(await client.screenshot(), 'base64');
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'The driver returns a PNG screenshot');
  await writeFile(resolve(output, filename), bytes);
  result.screenshots.push({ filename, sha256: hash(bytes), requiresVisualReview: true, captured: new Date().toISOString() });
}

async function preflight() {
  assert.equal(process.platform, 'darwin', 'Environment unavailable: this diagnostic requires macOS and stock Safari');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Environment unavailable: driver startup is restricted to ephemeral GitHub Actions jobs');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Environment unavailable: a GitHub-hosted runner is required; do not attach to a personal or self-hosted Mac');
  const probes = [
    ['macOS', '/usr/bin/sw_vers', []],
    ['safariDriverVersion', '/usr/bin/safaridriver', ['--version']],
    ['allowRemoteAutomation', '/usr/libexec/PlistBuddy', ['-c', 'Print :AllowRemoteAutomation', join(homedir(), 'Library/WebDriver/com.apple.Safari.plist')]],
    ['safariVersion', '/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', '/Applications/Safari.app/Contents/Info.plist']],
    ['safariBuild', '/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', '/Applications/Safari.app/Contents/Info.plist']],
  ];
  const results = await Promise.allSettled(probes.map(([, file, args]) => execute(file, args, { timeout: 10000 })));
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    report.environment[probes[i][0]] = result.status === 'fulfilled'
      ? { passed: true, value: result.value.stdout.trim(), stderr: result.value.stderr.trim() }
      : { passed: false, error: result.reason.message };
  }
  assert.ok(results.every(({ status }) => status === 'fulfilled'), 'Environment unavailable: read-only Safari/image preflight failed; inspect environment in report.json. No setup changes were attempted.');
  assert.equal(report.environment.allowRemoteAutomation.value.toLowerCase(), 'true', 'Environment unavailable: the runner image has not pre-enabled Safari remote automation. Do not enable it in this diagnostic.');
  report.sourceSha = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
  assert.equal(process.env.QA_CANDIDATE_SHA, PINNED_SOURCE, 'The exact candidate SHA must be declared');
  assert.equal(report.sourceSha, PINNED_SOURCE, 'The exact candidate must be checked out');
  await execute('git', ['diff', '--exit-code', PINNED_SOURCE, '--', '.']);
  report.runnerSha256 = hash(await readFile(fileURLToPath(import.meta.url)));
  report.publicHelperSha256 = hash(await readFile(new URL('./qa769-public-qcamera.mjs', import.meta.url)));
  assert.equal(report.publicHelperSha256, PUBLIC_HELPER_SHA256, 'The reviewed public-media helper must be unchanged');
}

async function loadFixtures() {
  const original = new Map();
  for (const [file, expected] of Object.entries(ORIGINAL_HASHES)) {
    const bytes = await readFile(resolve('public/demo-video', file));
    assert.equal(hash(bytes), expected, `Pinned original fixture ${file}`); original.set(file, bytes);
  }
  const production = await loadPublicQcameraReference();
  report.publicProductionProvenance = production.provenance;
  const variants = new Map([['original-synthetic', original], ['public-production', production.files]]);
  report.fixtureSha256 = Object.fromEntries([...variants].map(([variant, files]) => [variant,
    Object.fromEntries([...files].map(([file, bytes]) => [file, hash(bytes)])),
  ]));
  return variants;
}

async function exportReferenceFrames(files, provenance) {
  const folder = 'production-reference-frames';
  const directory = resolve(output, folder);
  await mkdir(directory, { recursive: true });
  const nominalFps = 20;
  const indices = [[30, 40, 50], [0], [0, 90, 100, 110, 140]];
  const durations = [0, 1, 2].map((segment) => Number(provenance.segments[`${segment}/qcamera.ts`].duration));
  assert.ok(durations.every((duration) => Number.isFinite(duration) && duration > 0));
  const evidence = report.productionReferenceFrames = {
    status: 'exporting', folder, nominalFps, segmentDurations: durations, frames: [],
    basis: 'Zero-based decoded frame index within each independently decoded pinned segment. Approximate absolute playlist position is the sum of preceding production EXTINF durations plus frameIndex/20. Original PTS cadence has microsecond variation; these positions are not claimed as measured browser timestamps.',
    method: 'Unchanged TS buffers go to FFmpeg stdin; select uses decoded frame index. PNG stdout is saved without scaling, frame overlays, video re-encoding, or any TS file. These offline references do not read from or modify the Safari renderer.',
    review: 'Production screenshot matching remains pending independent visual review. A browser clock value alone does not identify the presented source frame.',
    ffmpegVersion: (await execute('ffmpeg', ['-version'], { timeout: 10000 })).stdout.trim(),
    references: ['https://ffmpeg.org/ffmpeg-filters.html#select_002c-aselect', 'https://ffmpeg.org/ffmpeg-protocols.html#pipe'],
  };
  let playlistStartSeconds = 0;
  for (let segment = 0; segment < indices.length; segment += 1) {
    const sourceFile = `${segment}/qcamera.ts`, bytes = files.get(sourceFile);
    assert.equal(hash(bytes), provenance.segments[sourceFile].expectedSha256, 'Reference PNGs must use the pinned production bytes');
    for (const frameIndex of indices[segment]) {
      const filename = `${folder}/segment-${segment}-frame-${String(frameIndex).padStart(3, '0')}.png`;
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-i', 'pipe:0',
        '-map', '0:v:0', '-vf', `select='eq(n,${frameIndex})'`,
        '-fps_mode', 'passthrough', '-an', '-sn', '-dn', '-c:v', 'png', '-pix_fmt', 'rgb24',
        '-threads:v', '1', '-f', 'image2pipe', 'pipe:1'];
      let png;
      try {
        // Decode through EOF so the child consumes all stdin bytes. The select
        // expression emits exactly one frame without an early pipe close.
        // Only this owned offline decoder child may be terminated by its timeout.
        png = execFileSync('ffmpeg', args, { input: bytes, timeout: 15000, maxBuffer: 2 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        evidence.status = 'failed';
        evidence.failure = { sourceFile, frameIndex, status: error.status ?? null, signal: error.signal ?? null,
          code: error.code ?? null, stderr: error.stderr?.toString('utf8').slice(0, 4096) ?? '' };
        throw new Error(`Offline reference PNG export failed for segment ${segment}, frame ${frameIndex}`);
      }
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'FFmpeg must return one PNG reference frame');
      assert.equal(png.readUInt32BE(16), 526); assert.equal(png.readUInt32BE(20), 330);
      let offset = 8, imageEnded = false;
      while (offset + 12 <= png.length) {
        const length = png.readUInt32BE(offset), type = png.subarray(offset + 4, offset + 8).toString('ascii');
        offset += length + 12;
        assert.ok(offset <= png.length, 'Every PNG chunk is complete');
        if (type === 'IEND') { assert.equal(length, 0); imageEnded = true; break; }
      }
      assert.ok(imageEnded); assert.equal(offset, png.length, 'The output contains exactly one PNG image');
      await writeFile(resolve(output, filename), png);
      evidence.frames.push({ filename, sha256: hash(png), bytes: png.length, width: 526, height: 330,
        sourceFile, sourceSha256: hash(bytes), segment, frameIndex, playlistStartSeconds,
        approximatePlaylistTimeSeconds: Number((playlistStartSeconds + frameIndex / nominalFps).toFixed(6)),
        ffmpegArguments: args });
    }
    playlistStartSeconds += durations[segment];
  }
  assert.equal(evidence.frames.length, 9, 'Export every predeclared production reference frame');
  evidence.status = 'exported';
}

async function startDriver() {
  const reservation = createServer();
  await new Promise((accept, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', accept); });
  const port = reservation.address().port;
  await new Promise((accept) => reservation.close(accept));
  const log = await open(resolve(output, 'safaridriver.log'), 'w');
  report.driver = { binary: '/usr/bin/safaridriver', port, log: 'safaridriver.log', origin: `http://127.0.0.1:${port}` };
  let child;
  try {
    child = spawn('/usr/bin/safaridriver', ['--port', String(port)], { stdio: ['ignore', log.fd, log.fd] });
    report.driver.pid = child.pid;
    child.on('error', (error) => { report.driver.spawnError = error.message; });
    child.on('exit', (code, signal) => { report.driver.exit = { code, signal }; });
    child.unref();
  }
  finally { await log.close(); }
  const origin = report.driver.origin;
  let lastError;
  const ready = await waitUntil(async () => {
    if (report.driver.spawnError || report.driver.exit) return false;
    try { report.driver.status = await command(origin, 'GET', '/status', undefined, 1000); return report.driver.status?.ready === true; }
    catch (error) { lastError = error.message; return false; }
  }, 10000);
  report.driver.lastStartupError = lastError;
  assert.ok(ready, 'Environment unavailable: the existing pre-enabled SafariDriver did not become ready. Inspect safaridriver.log; no setup changes or process-killing were attempted.');
  // The system driver may delegate its HTTP service to an XPC process. Check
  // the allocated service port rather than assuming the child owns the socket.
  const listeners = await execute('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fn']);
  report.driver.listeners = listeners.stdout.trim();
  const addresses = listeners.stdout.split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1));
  assert.ok(addresses.length > 0 && addresses.every((address) => /^(127\.0\.0\.1|\[::1\]):\d+$/.test(address)),
    'Environment unavailable: SafariDriver must listen only on loopback; this diagnostic does not alter networking or security settings');
  return origin;
}

async function startFixtureServer(variants, cases) {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const match = /^\/case\/([a-zA-Z0-9-]+)\/(.*)$/.exec(pathname);
    const result = match && cases.get(match[1]), path = match?.[2];
    const files = result && variants.get(result.variant);
    let bytes = files?.get(path);
    let type = path?.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : path?.endsWith('.ts') ? 'video/mp2t' : 'text/javascript';
    const missing = result?.availability === 'missing-middle' && path === '1/qcamera.ts';
    if (missing) bytes = undefined;
    if (result && path === '') { type = 'text/html'; bytes = referenceHtml(result); }
    const entry = { pathname, path, at: Date.now(), method: req.method, range: req.headers.range || null,
      status: bytes ? 200 : 404, missing, variant: result?.variant, fileBytes: bytes?.length,
      fileSha256: bytes && path?.endsWith('.ts') ? hash(bytes) : null, completed: false };
    (result?.httpRequests || report.strayHttpRequests).push(entry);
    res.once('finish', () => { entry.completed = true; entry.completedAt = Date.now(); });
    res.once('close', () => { if (!res.writableFinished) entry.aborted = true; });
    if (!bytes) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end('Not found'); return; }
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (req.headers.range && !range) {
      entry.status = 416; res.writeHead(416, { ...headers, 'Content-Range': `bytes */${bytes.length}` }); res.end(); return;
    }
    const start = range ? Number(range[1]) : 0;
    const end = range ? Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1) : bytes.length - 1;
    if (start > end) { entry.status = 416; res.writeHead(416, { ...headers, 'Content-Range': `bytes */${bytes.length}` }); res.end(); return; }
    entry.byteRange = [start, end];
    if (range) { headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`; entry.status = 206; bytes = bytes.subarray(start, end + 1); }
    entry.responseBytes = req.method === 'HEAD' ? 0 : bytes.length;
    res.writeHead(entry.status, { ...headers, 'Content-Length': bytes.length });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function delivery(result, path, size) {
  const requests = result.httpRequests.filter((request) => request.path === path && request.method === 'GET'
    && request.completed && [200, 206].includes(request.status) && request.responseBytes > 0);
  const ranges = requests.map(({ byteRange }) => byteRange).sort((a, b) => a[0] - b[0]);
  let end = -1;
  for (const [start, nextEnd] of ranges) { if (start > end + 1) break; end = Math.max(end, nextEnd); }
  return { completeFileDelivered: end === size - 1, coveredThroughByte: end, fileBytes: size, requests: requests.length };
}

async function runCase(plan, driverOrigin, fixtureOrigin, cases, sessionIds, variants) {
  const files = variants.get(plan.variant);
  assert.ok(files, 'The declared variant has its own verified fixture map');
  const result = { ...plan, isolation: 'fresh WebDriver session, not a fresh Safari process', rvfcObserved: false,
    httpRequests: [], screenshots: [], observations: [], requiresVisualReview: true,
    visualReview: { status: 'pending', requestedTime: plan.target, toleranceSeconds: 0.6,
      method: plan.variant === 'public-production' ? 'independent-offline-reference-frame-review' : 'burned-timestamp-review',
      referenceFrames: plan.variant === 'public-production' ? report.productionReferenceFrames.frames.map(({ filename }) => filename) : [],
      instruction: plan.variant === 'public-production'
        ? 'This production clip has no burned timestamp. Independently compare screenshots with the pinned offline reference frames, including the first frame of segment 2 near 120s. Record the picture position separately from the requested target and measured browser clock; infer no presented-frame success from clock/quality counters.'
        : 'Read the burned frame timestamp against the requested target AND measured media clock. A frame matching a browser-adjusted clock does not prove the requested target was reached.' } };
  report.cases.push(result); cases.set(plan.name, result);
  let client;
  try {
    result.sessionCreationAttempted = true;
    const session = await command(driverOrigin, 'POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
    result.sessionId = session.sessionId; result.driverCapabilities = session.capabilities;
    if (result.sessionId) client = sessionClient(driverOrigin, result.sessionId);
    assert.ok(result.sessionId && !sessionIds.has(result.sessionId), 'Every case gets a distinct WebDriver session');
    sessionIds.add(result.sessionId);
    assert.equal(session.capabilities.browserName.toLowerCase(), 'safari');
    const url = `${fixtureOrigin}/case/${plan.name}/`;
    await client.navigate(url);
    result.capabilities = await client.evaluate(() => {
      const video = document.querySelector('video');
      return { userAgent: navigator.userAgent, platform: navigator.platform, hls: video.canPlayType('application/vnd.apple.mpegurl'),
        mediaSource: typeof MediaSource, managedMediaSource: typeof globalThis.ManagedMediaSource,
        rvfcAvailable: typeof video.requestVideoFrameCallback, quality: typeof video.getVideoPlaybackQuality,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, timeOrigin: performance.timeOrigin, setup: globalThis.qaSetup };
    });
    assert.equal(result.capabilities.quality, 'function', 'The strict quality oracle must be supported');
    assert.equal(result.capabilities.setup, 'ready', 'The declared transport initialized without a page setup error');
    result.startup = await sustained(client);
    if (plan.availability === 'missing-middle') {
      result.missingMiddleBeforeSeek = await waitUntil(() => result.httpRequests.some(({ path, status, completed }) =>
        path === '1/qcamera.ts' && status === 404 && completed), 10000);
      assert.equal(result.missingMiddleBeforeSeek, true, 'The real middle-segment 404 must precede the later target seek');
    }
    await client.evaluate(() => document.querySelector('video').pause());
    const observation = { requestedTime: plan.target, before: await client.evaluate(mediaSample) };
    result.observations.push(observation);
    observation.seekRequestedAt = Date.now();
    observation.seekCommand = await client.evaluate((target) => {
      const video = document.querySelector('video');
      try { video.currentTime = target; return { at: performance.now(), requestedTime: target, immediateTime: video.currentTime, seeking: video.seeking }; }
      catch (error) { return { error: { name: error.name, message: error.message } }; }
    }, plan.target);
    observation.clockSettled = await waitUntil(() => client.evaluate((target) => {
      const video = document.querySelector('video');
      return video.paused && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.3;
    }, plan.target), 10000);
    observation.pausedSamples = [];
    for (let i = 0; i < 6; i += 1) { if (i) await delay(200); observation.pausedSamples.push(await client.evaluate(mediaSample)); }
    const times = observation.pausedSamples.map(({ time }) => time);
    observation.stablePaused = observation.pausedSamples.every(({ paused, seeking, ready }) => paused && !seeking && ready >= 2)
      && Math.max(...times) - Math.min(...times) < 0.02;
    observation.atRequestedTarget = times.every((time) => Math.abs(time - plan.target) < 0.3);
    observation.paused = observation.pausedSamples.at(-1);
    observation.pausedMeasurementsCompletedAt = Date.now();
    const targetPath = `${Math.floor(plan.target / 60)}/qcamera.ts`;
    observation.targetDeliveryBeforeScreenshot = delivery(result, targetPath, files.get(targetPath).length);
    assert.equal(observation.targetDeliveryBeforeScreenshot.completeFileDelivered, true, 'The complete target fragment must be delivered before the first target screenshot');
    result.visualReview.actualClockTime = observation.paused.time;
    result.firstPausedSamplesRecorded = true;
    await capture(client, result, `paused-${plan.target}`);
    await client.evaluate(() => { document.querySelector('video').play().catch((error) => globalThis.qaPlayErrors.push({ name: error.name, message: error.message })); });
    observation.resumed = { afterPausedScreenshot: true, ...await sustained(client) };
    await client.evaluate(() => document.querySelector('video').pause());
    observation.afterResumePaused = await client.evaluate(mediaSample);
    await capture(client, result, `resumed-${plan.target}`);
    result.finalMedia = await client.evaluate(mediaSample);
    assert.equal(plan.transport, 'native');
    assert.ok(result.capabilities.hls); assert.equal(result.finalMedia.src, `${url}complete.m3u8`, 'The declared native transport was actually used');
    assert.equal(result.httpRequests.some(({ path }) => path === 'hls.js'), false, 'This native-only reference does not load Hls.js');
    result.deliveries = {};
    for (const path of ['complete.m3u8', '0/qcamera.ts', `${Math.floor(plan.target / 60)}/qcamera.ts`]) {
      result.deliveries[path] = delivery(result, path, files.get(path).length);
      assert.equal(result.deliveries[path].completeFileDelivered, true, `A complete response or completed ranges actually delivered ${path}`);
    }
    const mediaRequests = result.httpRequests.filter(({ path }) => /\.m3u8$|\.ts$/.test(path));
    assert.ok(mediaRequests.every(({ path, status }) => [200, 206].includes(status)
      || (plan.availability === 'missing-middle' && path === '1/qcamera.ts' && status === 404)), 'Only the declared missing middle returns an HTTP failure');
    if (plan.availability === 'missing-middle') assert.equal(result.missingMiddleBeforeSeek, true, 'The real middle-segment 404 must precede the later target seek');
    result.complete = true;
  } catch (error) {
    result.complete = false; result.collectionError = error.stack;
    if (result.sessionCreationAttempted && !result.sessionId) result.sessionStateUnknown = true;
  }
  finally {
    if (client) {
      try {
        Object.assign(result, await client.evaluate(() => ({ events: globalThis.qaEvents, playErrors: globalThis.qaPlayErrors,
          hlsErrors: globalThis.qaHlsErrors, pageErrors: globalThis.qaPageErrors, finalProbe: globalThis.qaProbe })));
        if (result.pageErrors?.length) { result.complete = false; result.pageErrorCollectionFailure = true; }
      } catch (error) { result.complete = false; result.collectionReadError = error.message; }
      try { await client.close(); result.sessionDeleted = true; }
      catch (error) { result.complete = false; result.sessionDeleteError = error.message; }
    }
    await save();
    console.log(JSON.stringify({ name: result.name, complete: result.complete, startup: result.startup?.passed,
      observations: result.observations.map(({ requestedTime, clockSettled, stablePaused, atRequestedTarget, resumed }) =>
        ({ requestedTime, clockSettled, stablePaused, atRequestedTarget, resumed: resumed?.passed })), visualReview: 'pending' }));
  }
}

async function main() {
  await mkdir(output, { recursive: true });
  let fixtureServer;
  try {
    await preflight();
    const variants = await loadFixtures();
    await exportReferenceFrames(variants.get('public-production'), report.publicProductionProvenance);
    const driverOrigin = await startDriver();
    const cases = new Map(), sessionIds = new Set();
    const fixture = await startFixtureServer(variants, cases); fixtureServer = fixture.server;
    report.fixtureOrigin = fixture.origin; report.status = 'collecting'; await save();
    for (const plan of report.plan) {
      await runCase(plan, driverOrigin, fixture.origin, cases, sessionIds, variants);
      const last = report.cases.at(-1);
      if (last.sessionStateUnknown) throw new Error('Session creation did not return an owned session ID; stop instead of risking overlapping Safari sessions');
      if (last.sessionId && !last.sessionDeleted) throw new Error('The owned session could not be closed; stop instead of creating overlapping Safari sessions');
    }
    report.collectionComplete = report.cases.length === report.plan.length && report.cases.every(({ complete, sessionDeleted }) => complete && sessionDeleted);
    report.startupPassed = report.cases.filter(({ startup }) => startup?.passed).length;
    report.failedClockObservations = report.cases.flatMap(({ observations }) => observations)
      .filter(({ clockSettled, stablePaused, atRequestedTarget, resumed }) => !clockSettled || !stablePaused || !atRequestedTarget || !resumed?.passed).length;
    report.status = report.collectionComplete ? 'collection-complete-visual-review-pending' : 'collection-incomplete';
    if (!report.collectionComplete) process.exitCode = 1;
  } catch (error) {
    report.failureStage = report.status; report.status = report.status === 'preflight' ? 'environment-or-input-unavailable' : 'collection-incomplete';
    report.error = error.stack; process.exitCode = 1;
    console.error(error.message);
  } finally {
    if (fixtureServer) await new Promise((accept) => fixtureServer.close(accept));
    report.finished = new Date().toISOString(); await save();
  }
}

await main();
