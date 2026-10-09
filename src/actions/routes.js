import * as Sentry from '@sentry/react';
import { api } from '../api/backend';
import { hasRoutesData } from '../timeline/segments';
import { hardNavigate } from '../utils/navigation';
import { isPublicLocation } from '../url';
import * as Types from './types';

const requests = new WeakMap();
const LIMIT_INCREMENT = 5;

function storeRequests(getState) {
  if (!requests.has(getState)) {
    const revisions = Object.values(getState().routeCacheRevisions || {});
    requests.set(getState, {
      pending: new Map(),
      revision: revisions.reduce((latest, value) => Math.max(latest, value), 0),
    });
  }
  return requests.get(getState);
}

function requestKey(state) {
  return JSON.stringify([
    state.dongleId, state.selectedRouteId ?? null,
    state.filter.start, state.filter.end, state.limit,
  ]);
}

function currentUrl(state) {
  const { pathname, search = '', hash = '' } = state.router?.location || window.location;
  return `${pathname}${search}${hash}`;
}

function normalizeRoutes(routesData) {
  return routesData.map((r) => {
    let startTime = r.segment_start_times[0];
    let endTime = r.segment_end_times[r.segment_end_times.length - 1];

    // Fix segment boundaries for routes that have the wrong time at the start.
    if ((Math.abs(r.start_time_utc_millis - startTime) > 24 * 60 * 60 * 1000)
        && (Math.abs(r.end_time_utc_millis - endTime) < 10 * 1000)) {
      startTime = r.start_time_utc_millis;
      endTime = r.end_time_utc_millis;
      r.segment_start_times = r.segment_numbers.map((x) => startTime + (x * 60 * 1000));
      r.segment_end_times = r.segment_numbers.map((x) => Math.min(startTime + ((x + 1) * 60 * 1000), endTime));
    }
    // Compatibility with older API responses.
    if (r.distance == null && r.length != null) r.distance = r.length;
    return {
      ...r,
      url: r.url.replace('chffrprivate.blob.core.windows.net', 'chffrprivate.azureedge.net'),
      log_id: r.fullname.split('|')[1],
      duration: endTime - startTime,
      start_time_utc_millis: startTime,
      end_time_utc_millis: endTime,
      // TODO: get this from the API; this is not correct for segments with a time jump.
      segment_durations: r.segment_start_times.map((x, i) => r.segment_end_times[i] - x),
    };
  }).sort((a, b) => b.create_time - a.create_time);
}

export function checkRoutesData({ retry = false } = {}) {
  return (dispatch, getState) => {
    const state = getState();
    const { dongleId, limit } = state;
    const routeId = state.selectedRouteId ?? null;
    const fullname = routeId && `${dongleId}|${routeId}`;
    const terminal = fullname && (state.routeCache?.[fullname] === null
      || ['error', 'missing'].includes(state.routeLoadStatus?.[fullname]));
    if (!dongleId) return;

    const key = requestKey(state);
    const registry = storeRequests(getState);
    const pending = registry.pending.get(key);
    if (pending) return pending.promise;
    if (!retry && (terminal || hasRoutesData(state))) return;

    const { start, end } = state.filter;
    registry.revision += 1;
    const { revision } = registry;
    if (fullname) dispatch({ type: Types.ACTION_ROUTE_LOAD_STATUS, key: fullname, status: 'loading' });
    const response = routeId
      ? api.routes.getRoutesSegments(dongleId, undefined, undefined, undefined, `${dongleId}|${routeId}`)
      : api.routes.getRoutesSegments(dongleId, start, end, limit);
    const request = {};

    request.promise = response.then((routesData) => {
      if (!Array.isArray(routesData)) throw new TypeError('Expected route metadata to be an array');

      const current = getState();
      if (routesData.length === 0 && !api.auth.isAuthenticated()) {
        if (requestKey(current) === key && isPublicLocation(currentUrl(current))
            && (!fullname || revision >= (current.routeCacheRevisions?.[fullname] || 0))) {
          hardNavigate(`/?r=${encodeURIComponent(currentUrl(current))}`);
        }
        // An empty anonymous response may need authentication on a later visit.
        return;
      }

      const routes = normalizeRoutes(routesData);
      // Responses populate their cache; the reducer decides which list still matches.
      dispatch({ type: Types.ACTION_ROUTES_METADATA, dongleId, routeId, start, end, limit, revision, routes });
      return routes;
    }).catch((err) => {
      console.error('Failure fetching routes metadata', err);
      Sentry.captureException(err, { fingerprint: 'timeline_fetch_routes' });
      const current = getState();
      if (fullname && requestKey(current) === key && revision >= (current.routeCacheRevisions?.[fullname] || 0)) {
        dispatch({ type: Types.ACTION_ROUTE_LOAD_STATUS, key: fullname, status: 'error' });
      }
    }).finally(() => {
      if (registry.pending.get(key) === request) registry.pending.delete(key);
    });
    registry.pending.set(key, request);
    return request.promise;
  };
}

export function checkLastRoutesData() {
  return (dispatch, getState) => {
    const { limit, routes, filter, selectedRouteId } = getState();
    if (selectedRouteId) return dispatch(checkRoutesData());
    // Fewer routes than requested means the last fetch reached the end.
    if (routes && routes.length < limit) return;

    dispatch({ type: Types.ACTION_UPDATE_ROUTE_LIMIT, limit: limit + LIMIT_INCREMENT });
    // Invalidate the list while keeping the current date filter.
    dispatch({ type: Types.ACTION_SELECT_TIME_FILTER, start: filter.start, end: filter.end });
    return dispatch(checkRoutesData());
  };
}

export function selectTimeFilter(start, end) {
  return (dispatch) => {
    dispatch({ type: Types.ACTION_SELECT_TIME_FILTER, start, end });
    dispatch({ type: Types.ACTION_UPDATE_ROUTE_LIMIT, limit: LIMIT_INCREMENT });
    return dispatch(checkRoutesData());
  };
}
