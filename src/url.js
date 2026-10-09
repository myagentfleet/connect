import { DEMO_DONGLE_ID } from './api/demo';

const dongleIdPattern = /^[a-f0-9]{16}$/;
const logIdPattern = /^[a-f0-9-]{20}$/;
const timePattern = /^\d+(?:\.\d{1,3})?$/;
const clipPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.mp4$/i;
const devicePages = ['dashboard', 'drive', 'prime', 'referrals'];
const clipPages = ['dashboard', 'drive'];

// Dialogs retain the page underneath them, including its drive and range.
const dialogs = {
  settings: { pages: devicePages, targetDevice: true },
  unpair: { pages: devicePages, targetDevice: true, parent: 'settings' },
  pair: { pages: devicePages, withoutDevice: true },
  filter: { pages: ['dashboard'] },
  uploads: { pages: devicePages, targetDevice: true, optionalParent: 'settings' },
  clips: { pages: clipPages },
  clip: { pages: clipPages, parent: 'clips', clipRequired: true },
  'delete-clip': { pages: clipPages, parent: 'clips', clipRequired: true },
  downloads: { pages: ['drive'] },
  'route-info': { pages: ['drive'] },
  'cancel-prime': { pages: ['prime'] },
  'change-plan': { pages: ['prime'] },
};

export function isDongleId(value) {
  return dongleIdPattern.test(value) || value === DEMO_DONGLE_ID;
}

function parseRange(parts, scale) {
  if (parts.length !== 2 || !parts.every((part) => timePattern.test(part))) return null;
  if (scale === 1 && parts.some((part) => part.includes('.'))) return null;
  const [start, end] = parts.map((part) => {
    if (scale === 1) return Number(part);
    const [seconds, fraction = ''] = part.split('.');
    return Number(seconds + fraction.padEnd(3, '0'));
  });
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || start >= end) return null;
  return { start, end };
}

function formatSeconds(milliseconds) {
  // Insert the decimal without losing millisecond digits near the safe-integer limit.
  const digits = String(Math.round(milliseconds)).padStart(4, '0');
  const fraction = digits.slice(-3).replace(/0+$/, '');
  return digits.slice(0, -3) + (fraction ? '.' + fraction : '');
}

export function sameRange(a, b) {
  return a?.start === b?.start && a?.end === b?.end;
}

export function parseLocation(location) {
  const { pathname, search = '' } = typeof location === 'string'
    ? new URL(location, 'https://connect.comma.ai') : location;
  const parts = pathname.replace(/\/+$/, '').split('/').slice(1);
  const route = {
    page: 'not-found', dongleId: null, logId: null, range: null,
    legacyRange: null, dialog: null, dialogDevice: null, dialogParent: null, dialogClip: null, pairToken: null,
  };

  if (parts.length === 0 || pathname === '/demo' || pathname === '/demo/') {
    route.page = 'dashboard';
    if (pathname.startsWith('/demo')) route.dongleId = DEMO_DONGLE_ID;
  } else if (parts.length === 1 && ['auth', 'referrals'].includes(parts[0])) {
    route.page = parts[0];
  } else if (isDongleId(parts[0])) {
    route.dongleId = parts[0];
    if (parts.length === 1) {
      route.page = 'dashboard';
    } else if (parts.length === 2 && ['prime', 'stream'].includes(parts[1])) {
      route.page = parts[1];
    } else if (logIdPattern.test(parts[1]) && [2, 4].includes(parts.length)) {
      const range = parts.length === 4 ? parseRange(parts.slice(2), 1000) : null;
      if (parts.length === 2 || range) {
        route.page = 'drive';
        route.logId = parts[1];
        route.range = range;
      }
    } else if (parts.length === 3) {
      route.legacyRange = parseRange(parts.slice(1), 1);
      if (route.legacyRange) route.page = 'drive';
    }
  }

  const params = new URLSearchParams(search);
  const pairToken = params.get('pair');
  const dialog = params.get('dialog') || (pairToken ? 'pair' : null);
  const definition = Object.hasOwn(dialogs, dialog) ? dialogs[dialog] : null;
  const dialogDevice = (definition?.targetDevice && params.get('device')) || route.dongleId;
  const clip = params.get('clip');
  if (definition?.pages.includes(route.page)
      && (definition.withoutDevice || isDongleId(dialogDevice))
      && (!definition.clipRequired || clipPattern.test(clip))) {
    route.dialog = dialog;
    route.dialogDevice = definition.targetDevice ? dialogDevice : null;
    route.dialogClip = definition.clipRequired ? clip : null;
    route.pairToken = dialog === 'pair' ? pairToken : null;
    route.dialogParent = definition.parent
      || (params.get('parent') === definition.optionalParent ? definition.optionalParent : null);
  }
  return route;
}

export function formatLocation({ page = 'dashboard', dongleId, logId, range }) {
  if (page === 'referrals' || page === 'auth') return '/' + page;
  if (!dongleId) return '/';
  const parts = [dongleId];
  if (page === 'drive') {
    parts.push(logId);
    if (range) parts.push(formatSeconds(range.start), formatSeconds(range.end));
  } else if (page === 'prime' || page === 'stream') {
    parts.push(page);
  }
  return '/' + parts.join('/');
}

export function withDialog(location, dialog, { deviceId = null, clip = null, pairToken = null } = {}) {
  const current = parseLocation(location);
  const definition = Object.hasOwn(dialogs, dialog) ? dialogs[dialog] : null;
  const params = new URLSearchParams(location.search);
  ['dialog', 'device', 'parent', 'clip', 'pair'].forEach((key) => params.delete(key));
  if (dialog) {
    params.set('dialog', dialog);
    if (definition?.targetDevice && deviceId) params.set('device', deviceId);
    if (definition?.clipRequired && clip) params.set('clip', clip);
    if (dialog === 'pair' && (pairToken || current.pairToken)) params.set('pair', pairToken || current.pairToken);
    const currentDevice = current.dialogDevice || current.dongleId;
    const parent = definition?.optionalParent;
    if (parent && (current.dialog === parent || current.dialogParent === parent)
        && (!deviceId || deviceId === currentDevice)) {
      params.set('parent', parent);
      params.set('device', currentDevice);
    }
  }
  const search = params.toString();
  return { ...location, search: search ? '?' + search : '' };
}

export function isPublicLocation(location) {
  const route = parseLocation(location);
  return route.page === 'drive' && [null, 'downloads', 'route-info'].includes(route.dialog);
}
