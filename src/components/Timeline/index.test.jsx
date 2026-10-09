import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { createStore } from 'redux';

import Timeline from '.';
import { pushTimelineRange } from '../../actions';

vi.mock('../../timeline', () => ({ currentOffset: () => 0 }));
vi.mock('../../actions', () => ({
  pushTimelineRange: vi.fn((logId, start, end) => ({ type: 'TEST_RANGE', logId, start, end })),
}));

function pointer(target, type, clientX, pointerType) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  fireEvent(target, event);
}

function renderTimeline() {
  const route = { log_id: '2026-08-06--12-00-00', start_time_utc_millis: 0, segment_numbers: [0], segment_offsets: [0] };
  const store = createStore((state = { zoom: { start: 0, end: 60000 } }) => state);
  const dispatch = vi.spyOn(store, 'dispatch');
  render(<Provider store={store}><Timeline route={route} hasRuler /></Provider>);
  const ruler = screen.getByRole('slider', { name: 'Drive timeline' });
  vi.spyOn(ruler, 'getBoundingClientRect').mockReturnValue({ x: 16, left: 16, width: 288, right: 304 });
  return { ruler, dispatch, route };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each([['mouse', 1], ['touch', 0]])('%s release seeks and only touch dismisses the time preview', (pointerType, previewCount) => {
  const { ruler, dispatch } = renderTimeline();
  pointer(ruler, 'pointermove', 160, pointerType);
  expect(screen.getByTestId('timeline-hover-badge')).toBeVisible();
  pointer(ruler, 'pointerdown', 160, pointerType);
  pointer(ruler, 'pointerup', 160, pointerType);
  expect(dispatch).toHaveBeenLastCalledWith({ type: 'ACTION_SEEK', offset: 30000 });
  expect(screen.queryAllByTestId('timeline-hover-badge')).toHaveLength(previewCount);
});

test('touch range selection still dispatches its exact interval after dismissing the preview', () => {
  const { ruler, route } = renderTimeline();
  pointer(ruler, 'pointerdown', 88, 'touch');
  pointer(document, 'pointermove', 232, 'touch');
  expect(screen.getByTestId('timeline-hover-badge')).toBeVisible();
  pointer(document, 'pointerup', 232, 'touch');
  expect(screen.queryByTestId('timeline-hover-badge')).not.toBeInTheDocument();
  expect(pushTimelineRange).toHaveBeenLastCalledWith(route.log_id, 15000, 45000);
});
