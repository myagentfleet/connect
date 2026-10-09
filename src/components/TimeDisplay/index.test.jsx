import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { createStore } from 'redux';

import TimeDisplay from '.';
import { currentOffset } from '../../timeline';
import { reducer as playbackReducer } from '../../timeline/playback';

vi.mock('../../timeline', () => ({ currentOffset: vi.fn() }));
vi.mock('../../utils/browser', () => ({ isIos: () => false }));

function renderControls() {
  const state = {
    currentRoute: { start_time_utc_millis: new Date(2026, 7, 6, 12).getTime() },
    desiredPlaySpeed: 1, offset: 0, zoom: { start: 0, end: 120000 },
  };
  const store = createStore((value = state, action) => playbackReducer(value, action));
  const dispatch = vi.spyOn(store, 'dispatch');
  const onMuteToggle = vi.fn();
  const view = render(<Provider store={store}><TimeDisplay isThin isMuted hasAudio onMuteToggle={onMuteToggle} /></Provider>);
  return { ...view, dispatch, onMuteToggle };
}

beforeEach(() => {
  currentOffset.mockReturnValue(0);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('the playback readout is local clock time followed by the zero-based route segment', () => {
  renderControls();
  const controls = screen.getByRole('group', { name: 'Playback controls' });
  expect(within(controls).getByText('12:00:00 – 0')).toBeVisible();
  currentOffset.mockReturnValue(61000);
  act(() => requestAnimationFrame.mock.calls[0][0]());
  expect(within(controls).getByText('12:01:01 – 1')).toBeVisible();
});

test('playback controls retain seeking, speed, pause/resume and mute behavior', () => {
  const { dispatch, onMuteToggle } = renderControls();
  currentOffset.mockReturnValue(30000);
  fireEvent.click(screen.getByRole('button', { name: 'Jump back 10 seconds' }));
  expect(dispatch).toHaveBeenLastCalledWith({ type: 'ACTION_SEEK', offset: 20000 });
  fireEvent.click(screen.getByRole('button', { name: 'Jump forward 10 seconds' }));
  expect(dispatch).toHaveBeenLastCalledWith({ type: 'ACTION_SEEK', offset: 40000 });
  fireEvent.change(screen.getByRole('combobox', { name: 'Playback speed' }), { target: { value: '2' } });
  expect(dispatch).toHaveBeenLastCalledWith({ type: 'ACTION_PLAY', speed: 2 });
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  expect(dispatch).toHaveBeenLastCalledWith({ type: 'ACTION_PAUSE' });
  fireEvent.click(screen.getByRole('button', { name: 'Unpause' }));
  expect(dispatch).toHaveBeenLastCalledWith({ type: 'ACTION_PLAY', speed: 2 });
  fireEvent.change(screen.getByRole('combobox', { name: 'Playback speed' }), { target: { value: '1' } });
  expect(dispatch).toHaveBeenLastCalledWith({ type: 'ACTION_PLAY', speed: 1 });
  fireEvent.click(screen.getByRole('button', { name: 'Unmute' }));
  expect(onMuteToggle).toHaveBeenCalledOnce();
});

test('changing the playback rate while paused preserves paused intent and applies on resume', () => {
  const { dispatch } = renderControls();
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  dispatch.mockClear();
  fireEvent.change(screen.getByRole('combobox', { name: 'Playback speed' }), { target: { value: '0.25' } });
  expect(dispatch).not.toHaveBeenCalled();
  expect(screen.getByRole('combobox', { name: 'Playback speed' })).toHaveValue('0.25');
  expect(screen.getByRole('button', { name: 'Unpause' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Unpause' }));
  expect(dispatch).toHaveBeenLastCalledWith({ type: 'ACTION_PLAY', speed: 0.25 });
});
