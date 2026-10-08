import { push, replace } from 'connected-react-router';
import { formatLocation, parseLocation, sameRange, withDialog } from '../url';

// All user navigation writes a URL. The history middleware alone applies it.
export function navigate(route, { replace: replaceEntry = false, state: historyState } = {}) {
  return (dispatch, getState) => {
    const location = getState().router.location;
    const pathname = formatLocation(route);
    if (pathname === location.pathname && !location.search && !location.hash) return;
    dispatch((replaceEntry ? replace : push)({ pathname, search: '', hash: '', state: historyState }));
  };
}

export function selectDevice(dongleId) {
  return navigate({ dongleId });
}

export function primeNav(open) {
  return (dispatch, getState) => dispatch(navigate({
    dongleId: getState().dongleId, page: open ? 'prime' : 'dashboard',
  }));
}

export function streamNav(open) {
  return (dispatch, getState) => dispatch(navigate({
    dongleId: getState().dongleId, page: open ? 'stream' : 'dashboard',
  }));
}

export function openDialog(dialog, options = {}) {
  return (dispatch, getState) => {
    const { router } = getState();
    const location = withDialog(router.location, dialog, options);
    if (location.pathname !== router.location.pathname || location.search !== router.location.search) {
      dispatch(push(location));
    }
  };
}

export function closeDialog() {
  return (dispatch, getState) => {
    const location = getState().router.location;
    const { dialogParent, dialogDevice } = parseLocation(location);
    const destination = withDialog(location, dialogParent, { deviceId: dialogDevice });
    if (destination.search !== location.search) dispatch(push(destination));
  };
}

export function pushTimelineRange(logId, start = null, end = null) {
  return (dispatch, getState) => {
    const { dongleId, selectedRouteId, zoom, navigation } = getState();
    // Playback uses milliseconds; keep URL selections at that precision.
    const range = start != null && end != null ? {
      start: Math.round(start), end: Math.max(Math.round(start) + 1, Math.round(end)),
    } : null;
    if (logId === selectedRouteId && sameRange(range, navigation.range) && !navigation.dialog) return;
    const previousZoom = logId === selectedRouteId && zoom
      ? { ...zoom, wholeDrive: navigation.range === null } : null;
    dispatch(navigate({ page: logId ? 'drive' : 'dashboard', dongleId, logId, range }, {
      state: { previousZoom },
    }));
  };
}

export function popTimelineRange() {
  return (dispatch, getState) => {
    const { dongleId, selectedRouteId: logId, zoom } = getState();
    if (!zoom?.previous) return;
    const previous = zoom.previous;
    const range = previous.wholeDrive ? null : { start: previous.start, end: previous.end };
    dispatch(navigate({ page: 'drive', dongleId, logId, range }, {
      state: { previousZoom: previous.previous || null },
    }));
  };
}
