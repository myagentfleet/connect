import { describe, expect, it } from 'vitest';
import { DEMO_DONGLE_ID } from './api/demo';
import { formatLocation, isPublicLocation, parseLocation, withDialog } from './url';

const DEVICE = '0000aaaa0000aaaa';
const OTHER = '1111bbbb1111bbbb';
const LOG = '2026-08-06--12-00-00';
const DRIVE = `/${DEVICE}/${LOG}`;
const CLIP = '2026-08-06--12-00-00.mp4';

describe('application URLs', () => {
  it.each([
    ['/', { page: 'dashboard', dongleId: null }],
    ['/referrals', { page: 'referrals' }],
    ['/auth/', { page: 'auth' }],
    ['/demo', { page: 'dashboard', dongleId: DEMO_DONGLE_ID }],
    [`/${DEMO_DONGLE_ID}/00000000--0000000001`, { page: 'drive', dongleId: DEMO_DONGLE_ID }],
    [`/${DEVICE}`, { page: 'dashboard', dongleId: DEVICE }],
    [`/${DEVICE}/prime`, { page: 'prime' }],
    [`/${DEVICE}/stream`, { page: 'stream' }],
    [DRIVE, { page: 'drive', logId: LOG, range: null, legacyRange: null }],
    [`${DRIVE}/0/20`, { page: 'drive', range: { start: 0, end: 20000 } }],
    [`${DRIVE}/0.123/0.456`, { page: 'drive', range: { start: 123, end: 456 } }],
    [`/${DEVICE}/1000/2000`, { page: 'drive', legacyRange: { start: 1000, end: 2000 }, range: null }],
  ])('parses %s', (url, expected) => {
    expect(parseLocation(url)).toMatchObject(expected);
  });

  it.each([
    '/not-a-device/prime', `/prefix${DEVICE}/prime`, `/${DEVICE}suffix`,
    `/${DEVICE}/stream/extra`, `${DRIVE}/10`, `${DRIVE}/10/20/extra`,
    `${DRIVE}/NaN/20`, `${DRIVE}/0/Infinity`, `${DRIVE}/10/10`, `${DRIVE}/20/10`,
    `${DRIVE}/-1/10`, `${DRIVE}/0/9007199254740992`, `/${DEVICE}//${LOG}`,
    `${DRIVE}/0.0000001/0.0000002`, `${DRIVE}/1e-7/2e-7`,
    `${DRIVE}/0/9007199254740.992`, `/${DEVICE}/0/9007199254740992`,
    `/${DEVICE}/not-a-route/1/2`, '/auth/code/provider',
  ])('rejects malformed route %s', (url) => {
    const route = parseLocation(url);
    expect(route.page).toBe('not-found');
    expect(route.range).toBeNull();
    expect(isPublicLocation(url)).toBe(false);
  });

  it.each([null, { start: 0, end: 1000 }, { start: 123, end: 456 }, { start: 1001, end: 2001 }, { start: 1000, end: 60000 }])(
    'round-trips whole drives and millisecond ranges (%j)', (range) => {
      const route = { page: 'drive', dongleId: DEVICE, logId: LOG, range };
      expect(parseLocation(formatLocation(route))).toMatchObject(route);
    },
  );

  it.each([
    [9007199254740988, 9007199254740989, '9007199254740.988/9007199254740.989'],
    [9007199254740990, Number.MAX_SAFE_INTEGER, '9007199254740.99/9007199254740.991'],
  ])('preserves exact millisecond ranges at the safe-integer boundary (%s, %s)', (start, end, seconds) => {
    const route = { page: 'drive', dongleId: DEVICE, logId: LOG, range: { start, end } };
    const pathname = `${DRIVE}/${seconds}`;
    expect(formatLocation(route)).toBe(pathname);
    expect(parseLocation(pathname)).toMatchObject(route);
    expect(parseLocation(`/${DEVICE}/${start}/${end}`).legacyRange).toEqual({ start, end });
  });

  it.each([
    [{ start: 0, end: 1 }, '0/0.001'],
    [{ start: 1000, end: 1010 }, '1/1.01'],
    [{ start: 1230, end: 2000 }, '1.23/2'],
  ])('formats canonical seconds without unnecessary fractional zeros (%j)', (range, seconds) => {
    expect(formatLocation({ page: 'drive', dongleId: DEVICE, logId: LOG, range })).toBe(`${DRIVE}/${seconds}`);
  });

  it.each([
    [`/${DEVICE}?dialog=settings`, 'settings', DEVICE],
    [`${DRIVE}?dialog=settings&device=${OTHER}`, 'settings', OTHER],
    ['/?dialog=pair', 'pair', null],
    [`/${DEVICE}?dialog=filter`, 'filter', null],
    [`${DRIVE}?dialog=uploads`, 'uploads', DEVICE],
    [`/referrals?dialog=uploads&device=${OTHER}`, 'uploads', OTHER],
    [`/?dialog=uploads&device=${OTHER}`, 'uploads', OTHER],
    [`${DRIVE}?dialog=clips`, 'clips', null],
    [`${DRIVE}?dialog=clip&clip=${CLIP}`, 'clip', null],
    [`${DRIVE}?dialog=delete-clip&clip=${CLIP}`, 'delete-clip', null],
    [`${DRIVE}?dialog=unpair&device=${OTHER}`, 'unpair', OTHER],
    [`${DRIVE}?dialog=downloads`, 'downloads', null],
    [`${DRIVE}?dialog=route-info`, 'route-info', null],
    [`/${DEVICE}/prime?dialog=cancel-prime`, 'cancel-prime', null],
    [`/${DEVICE}/prime?dialog=change-plan`, 'change-plan', null],
  ])('parses dialog %s', (url, dialog, dialogDevice) => {
    expect(parseLocation(url)).toMatchObject({ dialog, dialogDevice });
  });

  it.each([
    `${DRIVE}?dialog=filter`, '/?dialog=settings', `/${DEVICE}?dialog=unknown`,
    `/${DEVICE}?dialog=__proto__`, `/${DEVICE}?dialog=constructor`, `/${DEVICE}?dialog=toString`,
    `${DRIVE}?dialog=clip`, `${DRIVE}?dialog=delete-clip`,
    `${DRIVE}?dialog=clip&clip=..%2F${CLIP}`, `${DRIVE}?dialog=clip&clip=%2F${CLIP}`,
    `${DRIVE}?dialog=delete-clip&clip=example.txt`, `${DRIVE}?dialog=clip&clip=a%5Cb.mp4`,
    `/${DEVICE}/prime?dialog=clip&clip=${CLIP}`, '/?dialog=unpair',
    `${DRIVE}?dialog=unpair&device=invalid`,
  ])(
    'does not open a dialog without its required context: %s', (url) => {
      expect(parseLocation(url).dialog).toBeNull();
    },
  );

  it('preserves the complete parent location when opening and closing a dialog', () => {
    const location = { pathname: DRIVE, search: '?stripe_success=1&x=a%26b', hash: '#video', state: { previousZoom: null } };
    const opened = withDialog(location, 'settings', { deviceId: OTHER });
    expect(parseLocation(opened)).toMatchObject({ dialog: 'settings', dialogDevice: OTHER });
    expect(withDialog(opened, null)).toEqual(location);
  });

  it('keeps the settings parent explicit when opening its uploads dialog', () => {
    const settings = { pathname: DRIVE, search: `?x=1&dialog=settings&device=${OTHER}`, hash: '#video' };
    const uploads = withDialog(settings, 'uploads', { deviceId: OTHER });
    expect(parseLocation(uploads)).toMatchObject({ dialog: 'uploads', dialogDevice: OTHER, dialogParent: 'settings' });
    expect(parseLocation(withDialog(settings, 'uploads'))).toMatchObject({ dialogDevice: OTHER, dialogParent: 'settings' });
    expect(withDialog(uploads, 'settings', { deviceId: OTHER })).toEqual(settings);
    expect(parseLocation(withDialog(settings, 'uploads', { deviceId: DEVICE })).dialogParent).toBeNull();
    expect(parseLocation(`${DRIVE}?dialog=uploads&parent=unknown`).dialogParent).toBeNull();
    expect(parseLocation(`${DRIVE}?dialog=downloads&parent=settings`).dialogParent).toBeNull();
  });

  it.each(['clip', 'delete-clip'])('addresses the selected clip and its parent for %s', (dialog) => {
    const parent = { pathname: `${DRIVE}/0/20`, search: '?x=1&dialog=clips', hash: '#video', state: { previousZoom: null } };
    const child = withDialog(parent, dialog, { clip: CLIP });
    expect(parseLocation(child)).toMatchObject({ dialog, dialogClip: CLIP, dialogParent: 'clips' });
    expect(withDialog(child, 'clips')).toEqual(parent);
    expect(new URLSearchParams(withDialog(child, 'downloads').search).has('clip')).toBe(false);
  });

  it('keeps the unpair target and its settings parent explicit on a cold link', () => {
    const location = { pathname: DRIVE, search: '?x=1', hash: '#video' };
    const unpair = withDialog(location, 'unpair', { deviceId: OTHER });
    expect(parseLocation(unpair)).toMatchObject({ dialog: 'unpair', dialogDevice: OTHER, dialogParent: 'settings' });
    expect(withDialog(unpair, 'settings', { deviceId: OTHER }))
      .toEqual(withDialog(location, 'settings', { deviceId: OTHER }));
  });

  it.each(['?pair=token.value', '?dialog=pair&pair=token.value'])('normalizes a token-pairing URL %s', (search) => {
    const location = { pathname: '/', search, hash: '#pair' };
    expect(parseLocation(location)).toMatchObject({ dialog: 'pair', pairToken: 'token.value' });
    expect(withDialog(location, null)).toEqual({ ...location, search: '' });
    expect(parseLocation(withDialog(location, 'pair')).pairToken).toBe('token.value');
  });

  it('only exposes a pair token to the pair dialog and removes it on other navigation', () => {
    const location = { pathname: `/${DEVICE}`, search: '?x=1&dialog=settings&pair=token.value' };
    expect(parseLocation(location)).toMatchObject({ dialog: 'settings', pairToken: null });
    expect(withDialog(location, 'filter').search).toBe('?x=1&dialog=filter');
    expect(parseLocation(withDialog(location, 'pair', { pairToken: 'restored.token' })))
      .toMatchObject({ dialog: 'pair', pairToken: 'restored.token' });
  });

  it.each([
    [DRIVE, true], [`${DRIVE}/0/1`, true], [`${DRIVE}?dialog=downloads`, true],
    [`${DRIVE}?dialog=route-info`, true], [`${DRIVE}?dialog=settings`, false],
    [`${DRIVE}?dialog=clips`, false], [`/${DEVICE}/prime`, false],
    [`${DRIVE}?dialog=clip&clip=${CLIP}`, false], [`${DRIVE}?dialog=delete-clip&clip=${CLIP}`, false],
    [`${DRIVE}?dialog=unpair`, false], [`${DRIVE}?pair=token.value`, false],
  ])('recognizes the public access boundary for %s', (url, expected) => {
    expect(isPublicLocation(url)).toBe(expected);
  });
});
