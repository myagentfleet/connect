import React, { Component } from 'react';
import { connect } from 'react-redux';
import localforage from 'localforage';
import { push, replace } from 'connected-react-router';

import { withStyles, Typography } from '@material-ui/core';
import 'mapbox-gl/src/css/mapbox-gl.css';

import AppHeader from './AppHeader';
import Dashboard from './Dashboard';
import IosPwaPopup from './IosPwaPopup';
import AppDrawer from './AppDrawer';
import AppDialogs from './AppDialogs';
import BodyTeleop from './BodyTeleop';

import { streamNav } from '../actions';
import init from '../actions/startup';
import { formatLocation, parseLocation, withDialog } from '../url';
import { subscribeWindowSize } from '../hooks/window';

import DriveView from './DriveView';
import NoDeviceUpsell from './DriveView/NoDeviceUpsell';
import Referrals from './Referrals';

const styles = {
  app: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
  },
  window: {
    background: '#1D2225',
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
  },
};

class ExplorerApp extends Component {
  constructor(props) {
    super(props);

    this.state = {
      drawerIsOpen: false,
      headerRef: null,
      windowWidth: window.innerWidth,
    };

    this.handleDrawerStateChanged = this.handleDrawerStateChanged.bind(this);
    this.updateHeaderRef = this.updateHeaderRef.bind(this);
    this.closeBodyTeleop = this.closeBodyTeleop.bind(this);
  }

  closeBodyTeleop() {
    this.props.dispatch(streamNav(false));
  }

  async componentDidMount() {
    this.mounted = true;

    this.unsubscribeWindowSize = subscribeWindowSize(({ width }) => {
      this.setState({ windowWidth: width });
    });

    window.scrollTo({ top: 0 }); // for ios header

    const { location, dispatch } = this.props;
    const redirect = new URLSearchParams(location.search).get('r');
    const hasRedirect = redirect?.startsWith('/') && !redirect.startsWith('//');
    if (hasRedirect) {
      dispatch(replace(redirect));
    }

    // Older sign-ins stored the token before leaving connect. Restore only the
    // URL; AppDialogs owns the pairing flow, including its transaction result.
    this.pairingLocation = hasRedirect || parseLocation(location).dialog ? null : location;
    dispatch(init());
    if (!this.pairingLocation) return;
    try {
      const pairToken = await localforage.getItem('pairToken');
      const pairingLocation = this.pairingLocation;
      this.pairingLocation = null;
      if (!this.mounted || !pairingLocation || this.props.location !== pairingLocation
          || typeof pairToken !== 'string' || !pairToken) return;
      const destination = withDialog(pairingLocation, 'pair', { pairToken });
      if (parseLocation(destination).dialog === 'pair') dispatch(replace(destination));
    } catch (err) {
      console.error(err);
    }
  }

  componentWillUnmount() {
    this.mounted = false;
    this.unsubscribeWindowSize?.();
  }

  componentDidUpdate(prevProps) {
    if (prevProps.location !== this.props.location) {
      const { location, dongleId, historyAction } = this.props;
      const previous = prevProps.location;
      // Startup may select the default device while storage is loading. Follow
      // that one replacement; all subsequent navigation cancels restoration.
      const defaultSelection = this.pairingLocation === previous && previous.pathname === '/'
        && historyAction === 'REPLACE' && dongleId && location.pathname === formatLocation({ dongleId })
        && previous.search === location.search && previous.hash === location.hash;
      this.pairingLocation = defaultSelection ? location : null;
      this.setState({ drawerIsOpen: false });
    }
  }

  handleDrawerStateChanged(drawerOpen) {
    this.setState({
      drawerIsOpen: drawerOpen,
    });
  }

  updateHeaderRef(ref) {
    if (!this.state.headerRef) {
      this.setState({ headerRef: ref });
    }
  }

  render() {
    const {
      classes, currentRoute, devices, dispatch, dongleId, bodyTeleopOpen, page, profile,
    } = this.props;
    const { drawerIsOpen, windowWidth } = this.state;

    const noDevicesUpsell = (devices?.length === 0 && !dongleId);
    const referralsOpen = page === 'referrals';
    const isLarge = noDevicesUpsell || windowWidth > 1080;

    const sidebarWidth = noDevicesUpsell ? 0 : Math.max(280, windowWidth * 0.2);
    const headerHeight = this.state.headerRef
      ? this.state.headerRef.getBoundingClientRect().height
      : (windowWidth < 640 ? 111 : 66);
    let containerStyles = {};
    if (isLarge) {
      containerStyles = {
        ...containerStyles,
        width: `calc(100% - ${sidebarWidth}px)`,
        marginLeft: sidebarWidth,
      };
    }
    const drawerStyles = {
      minHeight: `calc(100vh - ${headerHeight}px)`,
    };

    return (
      <div className={classes.app}>
        { bodyTeleopOpen ? (
          <BodyTeleop onClose={ this.closeBodyTeleop } />
        ) : (
          <>
            <AppHeader
              drawerIsOpen={ drawerIsOpen }
              viewingRoute={ Boolean(currentRoute) }
              showDrawerButton={ !isLarge }
              handleDrawerStateChanged={this.handleDrawerStateChanged}
              forwardRef={ this.updateHeaderRef }
            />
            <AppDrawer
              drawerIsOpen={ drawerIsOpen }
              isPermanent={ isLarge }
              width={ sidebarWidth }
              handleDrawerStateChanged={this.handleDrawerStateChanged}
              style={ drawerStyles }
            />
            <div className={ classes.window } style={ containerStyles }>
              { referralsOpen
                ? <Referrals profile={profile} onBack={() => dispatch(push(dongleId ? `/${dongleId}` : '/'))} />
                : page === 'not-found'
                ? <Typography className="p-8">Page not found.</Typography>
                : noDevicesUpsell
                ? <NoDeviceUpsell />
                : (page === 'drive' ? <DriveView /> : <Dashboard />)}
            </div>
            <AppDialogs />
            <IosPwaPopup />
          </>
        ) }
      </div>
    );
  }
}

const stateToProps = (state) => ({
  location: state.router.location,
  historyAction: state.router.action,
  page: state.navigation.page,
  dongleId: state.dongleId,
  devices: state.devices,
  currentRoute: state.currentRoute,
  bodyTeleopOpen: state.navigation.page === 'stream',
  profile: state.profile,
});

export default connect(stateToProps)(withStyles(styles)(ExplorerApp));
