import { parseLocation } from './url';
import { getDefaultFilter } from './utils/filter';

export function createDeviceState() {
  return {
    routes: null,
    routesMeta: { dongleId: null, start: null, end: null },
    lastRoutes: null,
    subscription: null,
    subscribeInfo: null,
    files: null,
    filesUploading: {},
    filesUploadingMeta: { dongleId: null, fetchedAt: null },
    filter: getDefaultFilter(),
    limit: 0,
  };
}

export function createInitialState(location = window.location) {
  const navigation = parseLocation(location);
  return {
    ...createDeviceState(),
    navigation,
    dongleId: navigation.dongleId,
    selectedRouteId: navigation.logId,
    currentRoute: null,
    routeCache: {},
    routeCacheRevisions: {},
    routeLoadStatus: {},
    deviceCache: {},

    desiredPlaySpeed: 1,
    isBufferingVideo: true,
    offset: null,
    startTime: Date.now(),
    zoom: navigation.range ? { ...navigation.range, previous: location.state?.previousZoom || null } : null,
    loop: navigation.range ? {
      startTime: navigation.range.start,
      duration: navigation.range.end - navigation.range.start,
    } : null,

    profile: null,
    devices: null,
  };
}

export default createInitialState();
