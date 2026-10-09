import React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MuiThemeProvider } from '@material-ui/core/styles';
import { Provider } from 'react-redux';
import { createStore } from 'redux';

import TimeDisplay from '.';
import theme from '../../theme';
import { createInitialState } from '../../initialState';
import { reducer, videoProgress } from '../../timeline/playback';

const route = { fullname: 'drive', duration: 300000, start_time_utc_millis: Date.UTC(2026, 9, 9, 12) };

function mountControls() {
  const store = createStore((state, action) => action.type === 'TEST_ROUTE'
    ? { ...state, currentRoute: { ...route, fullname: 'next-drive' } }
    : reducer(state, action), {
    ...createInitialState('/'), currentRoute: route, offset: 125500,
    zoom: { start: 100000, end: 280000 }, isPlaying: false,
  });
  const onMuteToggle = vi.fn();
  const view = render(
    <Provider store={store}>
      <MuiThemeProvider theme={theme}>
        <TimeDisplay isMuted hasAudio onMuteToggle={onMuteToggle} />
      </MuiThemeProvider>
    </Provider>,
  );
  return { ...view, store, onMuteToggle };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('selection time follows media progress and transport seeks use the latest exact offset', () => {
  const { getByLabelText, getByRole, getByText, store, onMuteToggle } = mountControls();
  expect(getByLabelText('Selection playback time')).toHaveTextContent('0:25 / 3:00');
  expect(getByText(/Recorded .* · Segment 2/)).toBeVisible();
  act(() => store.dispatch(videoProgress(136789)));
  expect(getByLabelText('Selection playback time')).toHaveTextContent('0:36 / 3:00');
  expect(store.getState().seekRequest).toBeNull();
  fireEvent.click(getByRole('button', { name: 'Jump back 10 seconds' }));
  expect(store.getState().offset).toBe(126789);
  fireEvent.click(getByRole('button', { name: 'Jump forward 10 seconds' }));
  expect(store.getState().offset).toBe(136789);
  fireEvent.click(getByRole('button', { name: 'Play' }));
  expect(store.getState().isPlaying).toBe(true);
  fireEvent.click(getByRole('button', { name: 'Pause' }));
  expect(store.getState().isPlaying).toBe(false);
  fireEvent.click(getByRole('button', { name: 'Unmute' }));
  expect(onMuteToggle).toHaveBeenCalledOnce();
});

test('keyboard speed selection changes only speed and returns focus to its button', async () => {
  const { getByRole, queryByRole, store, onMuteToggle } = mountControls();
  const button = getByRole('button', { name: 'Playback speed' });
  button.focus();
  fireEvent.click(button);
  const selected = getByRole('menuitemradio', { name: '1×' });
  expect(selected).toHaveAttribute('aria-checked', 'true');
  expect(selected).toHaveFocus();
  fireEvent.keyDown(selected, { key: 'ArrowDown', keyCode: 40 });
  const faster = getByRole('menuitemradio', { name: '2×' });
  expect(faster).toHaveFocus();
  fireEvent.keyDown(faster, { key: 'Enter', keyCode: 13 });
  await waitFor(() => expect(queryByRole('menu')).not.toBeInTheDocument());
  expect(button).toHaveFocus();
  expect(button).toHaveTextContent('2×');
  expect(store.getState()).toMatchObject({ desiredPlaySpeed: 2, isPlaying: false, offset: 125500, seekRequest: null });
  expect(onMuteToggle).not.toHaveBeenCalled();
});

test('Escape and route navigation close the speed menu without changing playback', async () => {
  const { getByRole, queryByRole, store } = mountControls();
  const button = getByRole('button', { name: 'Playback speed' });
  button.focus();
  fireEvent.click(button);
  fireEvent.keyDown(getByRole('menu'), { key: 'Escape', keyCode: 27 });
  await waitFor(() => expect(queryByRole('menu')).not.toBeInTheDocument());
  expect(button).toHaveFocus();
  fireEvent.click(button);
  act(() => store.dispatch({ type: 'TEST_ROUTE' }));
  await waitFor(() => expect(queryByRole('menu')).not.toBeInTheDocument());
  expect(button).toHaveAttribute('aria-expanded', 'false');
  expect(store.getState()).toMatchObject({ desiredPlaySpeed: 1, isPlaying: false, seekRequest: null });
});

test.each([
  ['Chrome', ['0.1×', '0.25×', '0.5×', '1×', '2×', '4×', '8×']],
  ['iPhone', ['0.5×', '1×', '2×']],
])('speed choices preserve platform limits for %s', (userAgent, labels) => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  const { getByRole, getAllByRole } = mountControls();
  fireEvent.click(getByRole('button', { name: 'Playback speed' }));
  expect(getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(labels);
});
