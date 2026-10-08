// Loading and failures belong to a drive identity, not its dialogs or zoom.
export function routeLoadKey({ page, dongleId, logId, legacyRange }) {
  if (page !== 'drive' || !dongleId) return null;
  if (logId) return `${dongleId}|${logId}`;
  return legacyRange ? `legacy:${dongleId}/${legacyRange.start}/${legacyRange.end}` : null;
}
