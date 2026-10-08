import { ACTION_NAVIGATE } from '../actions/types';
import { createDeviceState } from '../initialState';
import { emptyDevice } from '../utils';
import { sameRange } from '../url';

// List/filter/subscription/file state survives visiting another device.
// Route metadata is reused separately by its fully qualified identity.
function rememberDevice(state) {
  return Object.fromEntries(Object.keys(createDeviceState()).map((key) => [key, state[key]]));
}

export function reconcileRouteList(routes, routeCache) {
  if (!routes) return routes;
  const cachedRoute = (route) => Object.hasOwn(routeCache, route.fullname) ? routeCache[route.fullname] : route;
  if (routes.every((route) => cachedRoute(route) === route)) return routes;
  return routes.map(cachedRoute).filter(Boolean);
}

export function resolveSelectedRoute(state) {
  const fullname = state.selectedRouteId && state.dongleId + '|' + state.selectedRouteId;
  const currentRoute = fullname
    ? (Object.hasOwn(state.routeCache, fullname)
      ? state.routeCache[fullname] : state.routes?.find((route) => route.fullname === fullname) || null)
    : null;
  const range = state.navigation.range || (currentRoute ? { start: 0, end: currentRoute.duration } : null);
  let { zoom, loop } = state;
  if (!sameRange(zoom, range)) {
    // Metadata can extend a whole drive. Explicit URL ranges stay fixed.
    const videoStart = zoom?.start === 0 ? state.currentRoute?.videoStartOffset || 0 : zoom?.start;
    const wholeLoop = !loop || (loop.startTime === videoStart && loop.startTime + loop.duration === zoom?.end);
    zoom = range ? { ...range, previous: zoom?.previous || null } : null;
    if (wholeLoop) loop = range ? { startTime: range.start, duration: range.end - range.start } : null;
  }
  return { ...state, currentRoute, zoom, loop };
}

export default function navigationReducer(state, action) {
  if (action.type !== ACTION_NAVIGATE) return state;
  const { navigation, previousZoom = null } = action;
  // Global pages keep the selected device as context, without selecting a drive.
  const dongleId = navigation.dongleId || state.dongleId;
  const deviceChanged = dongleId !== state.dongleId;
  let next = { ...state, navigation };
  if (deviceChanged) {
    const deviceCache = { ...state.deviceCache };
    if (state.dongleId) deviceCache[state.dongleId] = rememberDevice(state);
    const restored = deviceCache[dongleId] || createDeviceState();
    next = {
      ...next,
      ...restored,
      routes: reconcileRouteList(restored.routes, state.routeCache),
      lastRoutes: reconcileRouteList(restored.lastRoutes, state.routeCache),
      dongleId,
      deviceCache,
      device: state.devices?.find((device) => device.dongle_id === dongleId)
        || { ...emptyDevice, dongle_id: dongleId },
    };
  }

  const selectionChanged = deviceChanged || navigation.logId !== state.selectedRouteId
    || !sameRange(navigation.range, state.navigation.range);
  if (selectionChanged) {
    const range = navigation.range;
    next = {
      ...next,
      selectedRouteId: navigation.logId,
      currentRoute: null,
      zoom: range ? { ...range, previous: previousZoom } : null,
      loop: range ? { startTime: range.start, duration: range.end - range.start } : null,
      offset: range?.start || 0,
      startTime: Date.now(),
      desiredPlaySpeed: navigation.page === 'drive' ? 1 : 0,
      isBufferingVideo: true,
    };
    next = resolveSelectedRoute(next);
  }
  return next;
}
