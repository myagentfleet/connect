import { LOCATION_CHANGE, replace } from 'connected-react-router';
import { api } from '../api/backend';
import { formatLocation, isPublicLocation, parseLocation } from '../url';
import { routeLoadKey } from '../routeLoadStatus';
import { hardNavigate } from '../utils/navigation';
import { webrtcConnectionManager } from '../utils/webrtc';
import { ACTION_NAVIGATE, ACTION_ROUTE_LOAD_STATUS, ACTION_UPDATE_ROUTE_LIMIT } from './types';
import { checkRoutesData } from './routes';
import { primeFetchSubscription, fetchDeviceOnline, fetchSharedDevice } from './index';

const legacyRequests = new WeakMap();

function loadLegacyRoute(retry) {
  return (dispatch, getState) => {
    const { navigation, routeLoadStatus } = getState();
    const { dongleId, legacyRange } = navigation;
    const key = routeLoadKey(navigation);
    if (!retry && ['missing', 'error'].includes(routeLoadStatus?.[key])) return;

    if (!legacyRequests.has(getState)) legacyRequests.set(getState, new Map());
    const requests = legacyRequests.get(getState);
    if (requests.has(key)) return requests.get(key);
    dispatch({ type: ACTION_ROUTE_LOAD_STATUS, key, status: 'loading' });

    let response;
    try {
      response = api.routes.getRoutesSegments(dongleId, legacyRange.start, legacyRange.end);
    } catch (err) {
      response = Promise.reject(err);
    }
    const pending = Promise.resolve(response).then((routes) => {
      const state = getState();
      if (routeLoadKey(state.navigation) !== key) return;
      if (!Array.isArray(routes)) throw new TypeError('Expected route metadata to be an array');

      const route = routes.find((candidate) => candidate.start_time_utc_millis <= legacyRange.start
        && candidate.end_time_utc_millis > legacyRange.start)
        || routes.find((candidate) => candidate.start_time_utc_millis < legacyRange.end
          && candidate.end_time_utc_millis > legacyRange.start);
      if (!route) {
        const { location } = state.router;
        const authenticated = api.auth.isAuthenticated();
        dispatch({ type: ACTION_ROUTE_LOAD_STATUS, key, status: authenticated ? 'missing' : null });
        if (!authenticated && isPublicLocation(location)) {
          hardNavigate(`/?r=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
        }
        return;
      }

      const duration = route.end_time_utc_millis - route.start_time_utc_millis;
      const start = Math.max(0, legacyRange.start - route.start_time_utc_millis);
      const end = Math.min(duration, legacyRange.end - route.start_time_utc_millis);
      const range = start === 0 && end === duration ? null : { start, end };
      const pathname = formatLocation({ page: 'drive', dongleId, logId: route.fullname.split('|')[1], range });
      if (parseLocation(pathname).page !== 'drive') throw new TypeError('Invalid legacy route metadata');
      dispatch({ type: ACTION_ROUTE_LOAD_STATUS, key, status: null });
      dispatch(replace({ ...state.router.location, pathname }));
    }).catch((err) => {
      if (routeLoadKey(getState().navigation) !== key) return;
      console.error('Error converting legacy drive URL', err);
      dispatch({ type: ACTION_ROUTE_LOAD_STATUS, key, status: 'error' });
    }).finally(() => {
      requests.delete(key);
    });
    requests.set(key, pending);
    return pending;
  };
}

export function loadDevice(dongleId) {
  return (dispatch, getState) => {
    const { devices, profile } = getState();
    if (!devices) return;
    const device = devices.find((candidate) => candidate.dongle_id === dongleId);
    if (device && (device.is_owner || profile?.superuser)) {
      dispatch(primeFetchSubscription(dongleId, device, profile));
      dispatch(fetchDeviceOnline(dongleId));
    } else if (!device) {
      dispatch(fetchSharedDevice(dongleId));
    }
  };
}

export function loadLocation({ retry = false } = {}) {
  return (dispatch, getState) => {
    const { dongleId, navigation, limit, router } = getState();
    if (!dongleId || !['dashboard', 'drive'].includes(navigation.page)) return;
    if (!api.auth.isAuthenticated() && !isPublicLocation(router.location)) return;
    if (navigation.legacyRange) return dispatch(loadLegacyRoute(retry));
    if (limit === 0) dispatch({ type: ACTION_UPDATE_ROUTE_LIMIT, limit: 5 });
    return dispatch(checkRoutesData({ retry }));
  };
}

export function retryRoute() {
  return loadLocation({ retry: true });
}

export const onHistoryMiddleware = ({ dispatch, getState }) => (next) => (action) => {
  if (!action) return;
  const previous = getState();
  const result = next(action); // The router must see the location before derived state.
  if (action.type !== LOCATION_CHANGE) return result;

  const { location } = action.payload;
  const navigation = parseLocation(location);
  dispatch({ type: ACTION_NAVIGATE, navigation, previousZoom: location.state?.previousZoom });
  const state = getState();
  if (state.dongleId !== previous.dongleId) {
    if (previous.dongleId) webrtcConnectionManager.disconnect();
    if (state.dongleId) {
      localStorage.setItem('selectedDongleId', state.dongleId);
      dispatch(loadDevice(state.dongleId));
    }
  }
  dispatch(loadLocation());

  return result;
};
