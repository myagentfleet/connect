/* QA only: retrieve one explicitly public, hash-pinned qcamera reference. */
import { createHash } from 'node:crypto';

const ROUTE = '5beb9b58bd12b691|0000010a--a51155e496';
const API_ORIGIN = 'https://api.commadotai.com';
const ASSET_ORIGIN = 'https://commadata2.blob.core.windows.net';
const ROUTE_PATH = `/v1/route/${encodeURIComponent(ROUTE)}/`;
const ASSET_PREFIX = '/qlog/5beb9b58bd12b691/0000010a--a51155e496';
const JSON_BYTE_LIMIT = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const SEGMENTS = [
  { file: '0/qcamera.ts', bytes: 2231748, duration: '59.999955',
    sha256: '28e338210fcd1048ddafc695db5d6f660787ee9f5b2e43fa24a8ba022fd46c89' },
  { file: '1/qcamera.ts', bytes: 2233252, duration: '59.999906',
    sha256: 'd1ae569211effc2694a423f6eaf8c22a174862ade32cea70c97a226f5971fc2d' },
  { file: '2/qcamera.ts', bytes: 2230432, duration: '59.999896',
    sha256: 'fe35f6c2433832e1a55b9ec657cc6601df8b1b91222b17c0412f865f0bbbcbaa' },
];

class PublicQcameraReferenceError extends Error {
  constructor(stage, code, status) {
    super(`Public qcamera reference: ${stage}: ${code}${status === undefined ? '' : ` (HTTP ${status})`}`);
    this.name = 'PublicQcameraReferenceError';
    this.stage = stage;
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

const fail = (stage, code, status) => new PublicQcameraReferenceError(stage, code, status);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fetchBytes(url, stage, limit, expectedBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await globalThis.fetch(url, {
      redirect: 'error', credentials: 'omit', signal: controller.signal,
      headers: { Accept: expectedBytes === undefined ? 'application/json' : 'video/mp2t, application/octet-stream' },
    });
    if (response.status !== 200) throw fail(stage, 'HTTP_STATUS', response.status);
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null) {
      const length = Number(contentLength);
      if (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(length)) throw fail(stage, 'INVALID_CONTENT_LENGTH');
      if (length > limit) throw fail(stage, 'BODY_TOO_LARGE');
      if (expectedBytes !== undefined && length !== expectedBytes) throw fail(stage, 'BYTE_COUNT_MISMATCH');
    }
    if (!response.body) throw fail(stage, 'MISSING_BODY');
    const reader = response.body.getReader();
    const chunks = [];
    let count = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > limit) throw fail(stage, 'BODY_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
    if (expectedBytes !== undefined && count !== expectedBytes) throw fail(stage, 'BYTE_COUNT_MISMATCH');
    return Buffer.concat(chunks, count);
  } catch (error) {
    // Fetch/decoder errors may include a signed URL. Never retain their message or cause.
    if (error instanceof PublicQcameraReferenceError) throw error;
    throw fail(stage, controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'REQUEST_FAILED');
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function fetchJson(path, stage) {
  const bytes = await fetchBytes(`${API_ORIGIN}${path}`, stage, JSON_BYTE_LIMIT);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw fail(stage, 'INVALID_JSON'); }
}

function selectUrls(listing) {
  if (!Array.isArray(listing?.qcameras)) throw fail('file-listing', 'INVALID_QCAMERA_LIST');
  const urls = listing.qcameras.map((value) => {
    if (typeof value !== 'string') throw fail('file-listing', 'INVALID_ASSET_URL');
    try { return new URL(value); }
    catch { throw fail('file-listing', 'INVALID_ASSET_URL'); }
  });
  return SEGMENTS.map(({ file }, index) => {
    const stage = `segment-${index}`;
    const matches = urls.filter(({ pathname }) => pathname === `${ASSET_PREFIX}/${file}`);
    if (matches.length !== 1) throw fail(stage, 'EXPECTED_ONE_ASSET_URL');
    const [url] = matches;
    if (url.origin !== ASSET_ORIGIN || url.username || url.password || url.hash) throw fail(stage, 'UNEXPECTED_ASSET_URL');
    return url;
  });
}

export async function loadPublicQcameraReference() {
  const route = await fetchJson(ROUTE_PATH, 'route-metadata');
  if (route?.fullname !== ROUTE) throw fail('route-metadata', 'ROUTE_ID_MISMATCH');
  if (route.is_public !== true) throw fail('route-metadata', 'ROUTE_NOT_PUBLIC');
  const urls = selectUrls(await fetchJson(`${ROUTE_PATH}files`, 'file-listing'));
  // Finish all three bounded requests before returning data or a sanitized error.
  const fetched = await Promise.allSettled(SEGMENTS.map(async (segment, index) => {
    const bytes = await fetchBytes(urls[index], `segment-${index}`, segment.bytes, segment.bytes);
    if (sha256(bytes) !== segment.sha256) throw fail(`segment-${index}`, 'SHA256_MISMATCH');
    return bytes;
  }));
  for (const result of fetched) if (result.status === 'rejected') throw result.reason;
  const files = new Map(SEGMENTS.map(({ file }, index) => [file, fetched[index].value]));
  const manifest = Buffer.from([
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:61',
    '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
    ...SEGMENTS.flatMap(({ file, duration }, index) => [`#EXTINF:${duration},${index}`, file]),
    '#EXT-X-ENDLIST', '',
  ].join('\n'));
  files.set('complete.m3u8', manifest);
  const provenance = {
    kind: 'public-production-qcamera-reference', route: ROUTE, isPublic: true,
    fetchedAt: new Date().toISOString(), apiOrigin: API_ORIGIN,
    metadataPath: ROUTE_PATH, fileListingPath: `${ROUTE_PATH}files`, assetOrigin: ASSET_ORIGIN,
    access: 'Unauthenticated public-route metadata and file listing; temporary signed asset URLs stay in memory.',
    segments: Object.fromEntries(SEGMENTS.map((segment) => [segment.file, {
      sourcePath: `${ASSET_PREFIX}/${segment.file}`, bytes: files.get(segment.file).length,
      expectedBytes: segment.bytes, sha256: sha256(files.get(segment.file)), expectedSha256: segment.sha256,
      duration: segment.duration,
    }])),
    manifest: { file: 'complete.m3u8', sha256: sha256(manifest), targetDuration: 61,
      description: 'Locally generated three-segment excerpt using production durations and unchanged media bytes; URIs are local.' },
    mediaDescription: 'Previously inspected pinned bytes: H.264 High level 2.1, 526x330, 20 fps, approximately 0.75s keyframes, no audio.',
  };
  return { files, provenance };
}
