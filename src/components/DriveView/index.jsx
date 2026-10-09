import React, { Component } from 'react';
import { connect } from 'react-redux';
import dayjs from 'dayjs';

import { Button, IconButton, Typography } from '@material-ui/core';

import { navigate, popTimelineRange, pushTimelineRange } from '../../actions/navigation';
import { retryRoute } from '../../actions/history';
import { routeLoadKey } from '../../routeLoadStatus';
import { ArrowBackBold, CloseBold } from '../../icons';
import { filterRegularClick } from '../../utils';

import Media from './Media';
import Timeline from '../Timeline';

class DriveView extends Component {
  constructor(props) {
    super(props);
    this.close = this.close.bind(this);
    this.viewRef = React.createRef();
    this.scheduleVideoSize = this.scheduleVideoSize.bind(this);
  }

  componentDidMount() {
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.scheduleVideoSize);
      this.resizeObserver.observe(this.viewRef.current);
    }
    window.addEventListener('resize', this.scheduleVideoSize);
    this.scheduleVideoSize();
  }

  componentDidUpdate() {
    this.scheduleVideoSize();
  }

  componentWillUnmount() {
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.scheduleVideoSize);
    cancelAnimationFrame(this.videoSizeFrame);
  }

  scheduleVideoSize() {
    if (this.videoSizeFrame != null) return;
    this.videoSizeFrame = requestAnimationFrame(() => {
      this.videoSizeFrame = null;
      const view = this.viewRef.current;
      const frame = view?.querySelector('.DriveVideo');
      const controls = view?.querySelector('.PlaybackControlsContainer');
      if (window.innerWidth < 768 || !frame || !controls || !frame.getBoundingClientRect().width) {
        view?.style.removeProperty('--drive-video-height');
        return;
      }

      const media = frame.closest('.DriveMedia');
      const card = frame.closest('.DriveViewCard');
      if (!media || !card) return;
      const gap = parseFloat(getComputedStyle(media).rowGap) || 0;
      const padding = parseFloat(getComputedStyle(media.parentElement).paddingBottom) || 0;
      const margin = parseFloat(getComputedStyle(card).marginBottom) || 0;
      const map = media.querySelector('.mapboxgl-map');
      // Keep the existing useful media minimum and let very short windows scroll.
      const minimumHeight = Math.max(200, map ? parseFloat(getComputedStyle(map).minHeight) || 0 : 0);
      const top = frame.getBoundingClientRect().top + window.scrollY;
      const height = Math.max(minimumHeight, window.innerHeight - top
        - controls.getBoundingClientRect().height - gap - padding - margin);
      const value = `${height.toFixed(2)}px`;
      if (view.style.getPropertyValue('--drive-video-height') !== value) {
        view.style.setProperty('--drive-video-height', value);
      }
    });
  }

  onBack(zoom, currentRoute) {
    if (zoom.previous) {
      this.props.dispatch(popTimelineRange(currentRoute?.log_id));
    } else if (currentRoute) {
      this.props.dispatch(
        pushTimelineRange(currentRoute.log_id, null, null),
      );
    }
  }

  close() {
    this.props.dispatch(navigate({ page: 'dashboard', dongleId: this.props.dongleId }));
  }

  render() {
    const { dongleId, zoom, currentRoute, routeLoaded, loadStatus, range } = this.props;

    if (!currentRoute) {
      const failed = loadStatus === 'error';
      const missing = loadStatus === 'missing' || (routeLoaded && loadStatus !== 'loading');
      return (
        <div ref={this.viewRef} className="DriveView p-8">
          <Typography>{failed ? 'Could not load this drive. Please try again.' : missing ? 'Route does not exist.' : 'Loading...'}</Typography>
          {(failed || missing) && (
            <div className="mt-4 flex gap-2">
              <Button onClick={() => this.props.dispatch(retryRoute())}>Retry</Button>
              <Button onClick={filterRegularClick(this.close)} href={`/${dongleId}`}>Back to drives</Button>
            </div>
          )}
        </div>
      );
    }

    const backButtonDisabled = !zoom?.previous && !range;

    // FIXME: end time not always same day as start time
    const start = currentRoute.start_time_utc_millis + zoom.start;
    const startDateObj = dayjs(start);
    const startDay = startDateObj.format('dddd');
    const startDate = startDateObj.format(`MMM D${dayjs().year() === startDateObj.year() ? '' : ', YYYY'}`);
    const startTime = startDateObj.format('HH:mm');
    const endTime = dayjs(start + (zoom.end - zoom.start)).format('HH:mm');

    return (
      <div ref={this.viewRef} className="DriveView">
        <div className="DriveViewCard flex flex-col gap-4 rounded-lg m-4 bg-[linear-gradient(to_bottom,#30373B_0%,#272D30_10%,#1D2225_100%)]">
          <div>
            <div className="items-center justify-between flex p-3 gap-2">
              <IconButton
                onClick={ () => this.onBack(zoom, currentRoute) }
                aria-label="Go Back"
                disabled={ backButtonDisabled }
              >
                <ArrowBackBold />
              </IconButton>
              <div className="flex flex-col items-center gap-1 text-center text-white text-lg font-medium">
                {currentRoute.demo_title ? (
                  <div className="w-fit rounded-full bg-white/10 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-white/80">
                    {currentRoute.demo_title}
                  </div>
                ) : null}
                <div>
                  <span className="hidden sm:inline">{`${startDay} `}</span>
                  {startDate}
                  {' @ '}
                  <span className="whitespace-nowrap">{`${startTime} - ${endTime}`}</span>
                </div>
              </div>
              <IconButton
                onClick={ filterRegularClick(this.close) }
                aria-label="Close"
                href={ `/${dongleId}` }
              >
                <CloseBold />
              </IconButton>
            </div>
            <Timeline route={currentRoute} thumbnailsVisible hasRuler />
          </div>
          <div className='px-3 pb-3 md:px-8 md:pb-8'>
            <Media />
          </div>
        </div>
      </div>
    );
  }
}

const stateToProps = (state) => ({
  dongleId: state.dongleId,
  routeLoaded: Object.hasOwn(state.routeCache, state.dongleId + '|' + state.selectedRouteId),
  loadStatus: state.routeLoadStatus?.[routeLoadKey(state.navigation)],
  range: state.navigation.range,
  zoom: state.zoom,
  currentRoute: state.currentRoute,
});

export default connect(stateToProps)(DriveView);
