import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { createMemoryHistory } from 'history';
import { LOCATION_CHANGE } from 'connected-react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../../initialState';
import { createAppStore } from '../../store';
import AppHeader from '.';

vi.mock('@commaai/my-comma-auth', () => ({
  default: { isAuthenticated: () => true },
}));
vi.mock('../../analytics', () => ({
  analyticsMiddleware: () => (next) => (action) => next(action),
}));

const DEVICE = 'aaaaaaaaaaaaaaaa';

function renderHeader(pathname, dongleId = null) {
  const history = createMemoryHistory({ initialEntries: [pathname] });
  const initial = createInitialState(history.location);
  const store = createAppStore(history, {
    ...initial,
    dongleId,
    devices: [],
    profile: { email: 'test@example.com' },
    routes: [],
    routesMeta: { dongleId, ...initial.filter },
    limit: 5,
  });
  history.listen((location, action) => store.dispatch({ type: LOCATION_CHANGE, payload: { location, action } }));
  render(<Provider store={store}><AppHeader /></Provider>);
  return history;
}

afterEach(() => localStorage.clear());

describe('header navigation', () => {
  it.each(['/referrals', '/referrals/'])('returns from %s to the root when no device is selected', (pathname) => {
    const history = renderHeader(pathname);
    const referrals = screen.getByRole('button', { name: 'referrals' });
    expect(referrals).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'comma' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'connect' })).toHaveAttribute('href', '/');
    fireEvent.click(referrals);
    expect(history.location.pathname).toBe('/');
  });

  it('keeps the selected device in referrals links through Back and Forward', () => {
    const history = renderHeader(`/${DEVICE}`, DEVICE);
    fireEvent.click(screen.getByRole('button', { name: 'referrals' }));
    expect(history.location.pathname).toBe('/referrals');
    expect(screen.getByRole('button', { name: 'referrals' })).toHaveAttribute('href', `/${DEVICE}`);
    act(() => history.goBack());
    expect(screen.getByRole('button', { name: 'referrals' })).toHaveAttribute('href', '/referrals');
    act(() => history.goForward());
    fireEvent.click(screen.getByRole('button', { name: 'referrals' }));
    expect(history.location.pathname).toBe(`/${DEVICE}`);
  });

  it('does not push another entry when the account menu opens the current referrals page', () => {
    const history = renderHeader('/referrals/', DEVICE);
    fireEvent.click(screen.getByRole('button', { name: 'account menu' }));
    fireEvent.click(screen.getByRole('link', { name: 'Referrals', exact: true }));
    expect(history.location.pathname).toBe('/referrals/');
    expect(history.length).toBe(1);
  });
});
