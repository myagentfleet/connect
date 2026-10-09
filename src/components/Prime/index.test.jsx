import React from 'react';
import { Provider } from 'react-redux';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryHistory } from 'history';
import { LOCATION_CHANGE } from 'connected-react-router';

import { billing } from '../../api';
import { createInitialState } from '../../initialState';
import { createAppStore } from '../../store';
import { primeFetchSubscription } from '../../actions';
import Prime from '.';

vi.mock('../../api', () => ({ billing: {
  getSubscription: vi.fn(), cancelPrime: vi.fn(), switchPrimePlan: vi.fn(),
} }));
vi.mock('../../api/backend', () => ({ api: { auth: { isAuthenticated: () => true } } }));
vi.mock('../../analytics', () => ({ analyticsMiddleware: () => next => action => next(action) }));
vi.mock('../../utils/webrtc', () => ({ webrtcConnectionManager: { disconnect: vi.fn() } }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));
vi.mock('./PrimeCheckout', () => ({ default: () => <input aria-label="Checkout draft" defaultValue="" /> }));

const DEVICE = 'aaaaaaaaaaaaaaaa';
const PATH = `/${DEVICE}/prime`;
const subscription = { user_id: 'test-user', plan: 'nodata', subscribed_at: 1000, next_charge_at: 2000 };

function create(dialog, { prime = false, ...extra } = {}) {
  const history = createMemoryHistory({ initialEntries: [`${PATH}?x=1&dialog=${dialog}#billing`] });
  const device = { dongle_id: DEVICE, is_owner: true, prime };
  const store = createAppStore(history, {
    ...createInitialState(history.location),
    device, devices: [device], profile: { id: 'test-user' },
    ...extra,
  });
  const unlisten = history.listen((location, action) => store.dispatch({
    type: LOCATION_CHANGE, payload: { location, action },
  }));
  const view = render(<Provider store={store}><Prime /></Provider>);
  return { ...view, history, store, unlisten };
}

beforeEach(() => {
  vi.clearAllMocks();
});

test.each(['cancel-prime', 'change-plan'])('a cold %s link without Prime stays visible and closes through history', (dialog) => {
  const { history, unlisten } = create(dialog);
  const modal = screen.getByRole('dialog');
  expect(within(modal).getByText('This device does not have a prime subscription to manage.')).toBeVisible();
  expect(within(modal).queryByRole('button', { name: /Cancel subscription|Confirm switch/ })).not.toBeInTheDocument();

  fireEvent.click(within(modal).getByRole('button', { name: 'Close' }));
  expect(history.location).toMatchObject({ pathname: PATH, search: '?x=1', hash: '#billing' });
  const draft = screen.getByRole('textbox', { name: 'Checkout draft' });
  fireEvent.change(draft, { target: { value: 'retained' } });
  act(() => history.goBack());
  expect(screen.getByRole('dialog')).toBeVisible();
  act(() => history.goForward());
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Checkout draft' })).toBe(draft);
  expect(draft).toHaveValue('retained');
  expect(billing.cancelPrime).not.toHaveBeenCalled();
  expect(billing.switchPrimePlan).not.toHaveBeenCalled();
  unlisten();
});

test.each([
  ['cancel-prime', 'Cancel prime subscription', 'Cancel subscription'],
  ['change-plan', 'Switch to Standard plan', 'Confirm switch'],
])('a cold %s link waits for subscription details before showing transaction controls', async (dialog, title, button) => {
  let resolve;
  billing.getSubscription.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const { store, history, unlisten } = create(dialog, { prime: true });
  act(() => store.dispatch(primeFetchSubscription(DEVICE)));
  const modal = screen.getByRole('dialog');
  expect(within(modal).getByText('Subscription details are not available yet. Please try again later.')).toBeVisible();
  expect(within(modal).queryByRole('button', { name: button })).not.toBeInTheDocument();
  await act(async () => resolve(subscription));
  const loaded = screen.getByRole('dialog', { name: title });
  expect(within(loaded).getByRole('button', { name: button })).toBeEnabled();
  expect(history.location.search).toBe(`?x=1&dialog=${dialog}`);
  expect(billing.cancelPrime).not.toHaveBeenCalled();
  expect(billing.switchPrimePlan).not.toHaveBeenCalled();
  unlisten();
});

test.each([null, {}])('a completed unavailable subscription (%j) keeps a dismissible dialog', async (response) => {
  billing.getSubscription.mockResolvedValueOnce(response);
  const { store, history, unlisten } = create('cancel-prime', { prime: true });
  await act(async () => store.dispatch(primeFetchSubscription(DEVICE)));
  const modal = screen.getByRole('dialog');
  expect(within(modal).getByText('Subscription details are not available yet. Please try again later.')).toBeVisible();
  fireEvent.click(within(modal).getByRole('button', { name: 'Close' }));
  expect(history.location.search).toBe('?x=1');
  act(() => history.goBack());
  expect(screen.getByRole('dialog')).toBeVisible();
  expect(billing.cancelPrime).not.toHaveBeenCalled();
  unlisten();
});
