import { reducer as playbackReducer } from '../timeline/playback';
import initialState from '../initialState';
import globalState from './globalState';
import navigationReducer from './navigation';

// Pipe the flat root state through global + playback reducers in order.
export default function rootReducer(state = initialState, action) {
  return playbackReducer(globalState(navigationReducer(state, action), action), action);
}
