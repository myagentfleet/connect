import * as Types from '../actions/types';
import { emptyDevice } from '../utils';
import { reconcileRouteList, resolveSelectedRoute } from './navigation';

function updateRoute(state, fullname, fields) {
  const previous = Object.hasOwn(state.routeCache, fullname)
    ? state.routeCache[fullname] : state.routes?.find((route) => route.fullname === fullname);
  if (!previous) return state;
  const updated = { ...previous, ...fields };
  const routeCache = { ...state.routeCache, [fullname]: updated };
  return {
    ...state,
    routeCache,
    routes: reconcileRouteList(state.routes, routeCache),
    lastRoutes: reconcileRouteList(state.lastRoutes, routeCache),
    currentRoute: state.currentRoute?.fullname === fullname ? updated : state.currentRoute,
  };
}

function populateFetchedAt(d) {
  return {
    ...d,
    fetched_at: Math.floor(Date.now() / 1000),
  };
}

function deviceCompareFn(a, b) {
  if (a.is_owner !== b.is_owner) {
    return b.is_owner - a.is_owner;
  }
  if (a.alias && b.alias) {
    return a.alias.localeCompare(b.alias);
  }
  if (!a.alias && !b.alias) {
    return a.dongle_id.localeCompare(b.dongle_id);
  }
  return Boolean(b.alias) - Boolean(a.alias);
}

export default function reducer(_state, action) {
  let state = { ..._state };
  let deviceIndex = null;
  switch (action.type) {
    case Types.ACTION_STARTUP_DATA: {
      const devices = action.devices.map(populateFetchedAt).sort(deviceCompareFn);

      state.dongleId = state.dongleId || action.defaultDongleId || null;
      state.device = devices.find((device) => device.dongle_id === state.dongleId)
        || { ...emptyDevice, dongle_id: state.dongleId };
      state.devices = devices;
      state.profile = action.profile;
      break;
    }
    case Types.ACTION_SELECT_TIME_FILTER:
      state = {
        ...state,
        lastRoutes: state.routes,
        filter: {
          start: action.start,
          end: action.end,
        },
        routesMeta: {
          dongleId: null,
          start: null,
          end: null,
        },
        routes: null,
      };
      break;
    case Types.ACTION_UPDATE_ROUTE_LIMIT:
      state = {
        ...state,
        limit: action.limit,
      };
      break;
    case Types.ACTION_UPDATE_DEVICES:
      state = {
        ...state,
        devices: action.devices
          .map((d) => {
            // `rpc` holds Athena RPC-fetched values that would be wiped by listDevices payload
            const prev = (_state.devices || []).find((p) => p.dongle_id === d.dongle_id);
            return prev && prev.rpc ? { ...d, rpc: prev.rpc } : d;
          })
          .map(populateFetchedAt)
          .sort(deviceCompareFn),
      };
      if (state.dongleId) {
        const newDevice = state.devices.find((d) => d.dongle_id === state.dongleId);
        if (newDevice) {
          state.device = newDevice;
        }
      }
      break;
    case Types.ACTION_UPDATE_DEVICE: {
      state = {
        ...state,
        devices: state.devices ? [...state.devices] : [],
      };
      deviceIndex = state.devices.findIndex((d) => d.dongle_id === action.device.dongle_id);
      const isSelected = state.device?.dongle_id === action.device.dongle_id;
      const previousDevice = isSelected ? state.device : state.devices[deviceIndex];
      const updatedDevice = populateFetchedAt({
        ...previousDevice, // retains rpc, network_metered
        ...action.device,  // updates alias and other returned fields
      });

      if (deviceIndex !== -1) {
        state.devices[deviceIndex] = updatedDevice;
      } else {
        state.devices.unshift(updatedDevice);
      }

      if (isSelected) {
        state.device = updatedDevice;
      }

      break;
    }
    case Types.ACTION_UPDATE_ROUTE:
      state = updateRoute(state, action.fullname, action.route);
      break;
    case Types.ACTION_UPDATE_ROUTE_EVENTS: {
      const firstFrame = action.events.find((event) => event.type === 'event'
        && event.data.event_type === 'first_road_camera_frame');
      state = updateRoute(state, action.fullname, {
        events: action.events,
        videoStartOffset: firstFrame ? firstFrame.route_offset_millis : null,
      });
      break;
    }
    case Types.ACTION_UPDATE_ROUTE_LOCATION:
      state = updateRoute(state, action.fullname, { [action.locationKey]: action.location });
      break;
    case Types.ACTION_UPDATE_SHARED_DEVICE:
      if (action.dongleId === state.dongleId) {
        state.device = populateFetchedAt(action.device);
      }
      break;
    case Types.ACTION_UPDATE_DEVICE_ONLINE:
      state = {
        ...state,
        devices: [...state.devices],
      };
      deviceIndex = state.devices.findIndex((d) => d.dongle_id === action.dongleId);

      if (deviceIndex !== -1) {
        state.devices[deviceIndex] = {
          ...state.devices[deviceIndex],
          last_athena_ping: action.last_athena_ping,
          fetched_at: action.fetched_at,
        };
      }

      if (state.device.dongle_id === action.dongleId) {
        state.device = {
          ...state.device,
          last_athena_ping: action.last_athena_ping,
          fetched_at: action.fetched_at,
        };
      }
      break;
    case Types.ACTION_UPDATE_DEVICE_NETWORK:
      state = {
        ...state,
        devices: [...state.devices],
      };
      deviceIndex = state.devices.findIndex((d) => d.dongle_id === action.dongleId);

      if (deviceIndex !== -1) {
        state.devices[deviceIndex] = {
          ...state.devices[deviceIndex],
          network_metered: action.networkMetered,
        };
      }

      if (state.device.dongle_id === action.dongleId) {
        state.device = {
          ...state.device,
          network_metered: action.networkMetered,
        };
      }
      break;
    case Types.ACTION_UPDATE_DEVICE_RPC:
      // merge RPC-fetched values (e.g. not_car) into a specific device's `rpc` field
      state = {
        ...state,
        devices: [...state.devices],
      };
      deviceIndex = state.devices.findIndex((d) => d.dongle_id === action.dongleId);

      if (deviceIndex !== -1) {
        state.devices[deviceIndex] = {
          ...state.devices[deviceIndex],
          rpc: {
            ...state.devices[deviceIndex].rpc,
            ...action.fields,
          },
        };
      }

      if (state.device.dongle_id === action.dongleId) {
        state.device = {
          ...state.device,
          rpc: {
            ...state.device.rpc,
            ...action.fields,
          },
        };
      }
      break;
    case Types.ACTION_PRIME_SUBSCRIPTION:
      if (action.dongleId !== state.dongleId) { // ignore outdated info
        break;
      }
      state = {
        ...state,
        subscription: action.subscription,
        subscribeInfo: null,
      };
      break;
    case Types.ACTION_PRIME_SUBSCRIBE_INFO:
      if (action.dongleId !== state.dongleId) {
        break;
      }
      state = {
        ...state,
        subscribeInfo: action.subscribeInfo,
        subscription: null,
      };
      break;
    case Types.ACTION_FILES_URLS:
      state.files = {
        ...(state.files !== null ? { ...state.files } : {}),
        ...action.urls,
      };
      break;
    case Types.ACTION_FILES_UPDATE:
      state.files = {
        ...(state.files !== null ? { ...state.files } : {}),
        ...action.files,
      };
      break;
    case Types.ACTION_FILES_UPLOADING:
      state.filesUploading = action.uploading;
      state.filesUploadingMeta = {
        dongleId: action.dongleId,
        fetchedAt: Date.now(),
      };
      if (Object.keys(action.files).length) {
        state.files = {
          ...(state.files !== null ? { ...state.files } : {}),
          ...action.files,
        };
      }
      break;
    case Types.ACTION_FILES_CANCELLED_UPLOADS:
      if (state.files) {
        const cancelFileNames = Object.keys(state.filesUploading)
          .filter((id) => action.ids.includes(id))
          .map((id) => state.filesUploading[id].fileName);
        state.files = Object.keys(state.files)
          .filter((fileName) => !cancelFileNames.includes(fileName))
          .reduce((obj, fileName) => { obj[fileName] = state.files[fileName]; return obj; }, {});
      }
      state.filesUploading = Object.keys(state.filesUploading)
        .filter((id) => !action.ids.includes(id))
        .reduce((obj, id) => { obj[id] = state.filesUploading[id]; return obj; }, {});
      break;
    case Types.ACTION_ROUTE_LOAD_STATUS:
      state.routeLoadStatus = { ...state.routeLoadStatus };
      if (action.status) state.routeLoadStatus[action.key] = action.status;
      else delete state.routeLoadStatus[action.key];
      break;
    case Types.ACTION_ROUTES_METADATA: {
      const routeCache = { ...state.routeCache };
      const revisions = { ...state.routeCacheRevisions };
      const routeLoadStatus = { ...state.routeLoadStatus };
      const revision = action.revision ?? 0;
      action.routes.forEach((route) => {
        if (revision < (revisions[route.fullname] || 0)) return;
        routeCache[route.fullname] = { ...routeCache[route.fullname], ...route };
        revisions[route.fullname] = revision;
        delete routeLoadStatus[route.fullname];
      });
      if (action.routeId && action.routes.length === 0) {
        const fullname = action.dongleId + '|' + action.routeId;
        if (revision >= (revisions[fullname] || 0)) {
          routeCache[fullname] = null;
          revisions[fullname] = revision;
          delete routeLoadStatus[fullname];
        }
      }

      const activeDevice = action.dongleId === state.dongleId;
      const deviceState = activeDevice ? state : state.deviceCache[action.dongleId];
      if (!action.routeId && deviceState && action.limit === deviceState.limit
          && action.start === deviceState.filter.start && action.end === deviceState.filter.end) {
        const list = {
          routes: action.routes.map((route) => routeCache[route.fullname]).filter(Boolean),
          routesMeta: { dongleId: action.dongleId, start: action.start, end: action.end },
        };
        if (activeDevice) Object.assign(state, list);
        else state.deviceCache = { ...state.deviceCache, [action.dongleId]: { ...deviceState, ...list } };
      }
      state.routeCache = routeCache;
      state.routeCacheRevisions = revisions;
      state.routeLoadStatus = routeLoadStatus;
      state.routes = reconcileRouteList(state.routes, routeCache);
      state.lastRoutes = reconcileRouteList(state.lastRoutes, routeCache);
      if (activeDevice) state = resolveSelectedRoute(state);
      break;
    }
    default:
      return _state;
  }

  return state;
}
