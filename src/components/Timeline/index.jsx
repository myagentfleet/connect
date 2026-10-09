// timeline minimap
// rapidly change high level timeline stuff
// rapid seeking, etc
import React, { Component } from 'react';
import { connect } from 'react-redux';
import { withStyles } from '@material-ui/core/styles';
import dayjs from 'dayjs';

import Thumbnails from './thumbnails';
import theme from '../../theme';
import { pushTimelineRange } from '../../actions';
import Colors from '../../colors';
import { seek } from '../../timeline/playback';
import { formatPlaybackTime } from '../../utils';

const styles = () => ({
  base: {
    position: 'relative',
    '&.hasRuler': {
      cursor: 'crosshair',
      touchAction: 'none',
      '& $segments, & $segment, & $segmentColor, & $statusGradient': { height: 4 },
      '& $thumbnails': { height: 44 },
      '&:focus-visible': { outline: `2px solid ${Colors.lightBlue900}`, outlineOffset: -2 },
      '&:hover $playhead, &:focus-visible $playhead': { backgroundColor: Colors.lightBlue700 },
    },
  },
  segments: {
    position: 'relative',
    left: '0px',
    width: '100%',
    overflow: 'hidden',
    height: 12,
  },
  segment: {
    position: 'absolute',
    height: 12,
    background: theme.palette.states.drivingBlue,
  },
  statusGradient: {
    background: 'linear-gradient(rgba(0, 0, 0, 0.0) 4%, rgba(255, 255, 255, 0.025) 10%, rgba(0, 0, 0, 0.1) 25%, rgba(0, 0, 0, 0.4))',
    height: 12,
    left: 0,
    pointerEvents: 'none',
    position: 'absolute',
    top: 0,
    width: '100%',
    zIndex: 2,
  },
  segmentColor: {
    position: 'absolute',
    display: 'inline-block',
    height: 12,
    width: '100%',
    '&.active': {},
    '&.engage': {
      background: theme.palette.states.engagedGreen,
    },
    '&.overriding': {
      background: theme.palette.states.engagedGrey,
    },
    '&.alert': {
      '&.userPrompt': {
        background: theme.palette.states.alertOrange,
      },
      '&.critical': {
        background: theme.palette.states.alertRed,
      },
    },
    '&.bookmark, &.flag': {  // TODO: remove flag selector once 14 days expires old events caches
      background: theme.palette.states.userBookmark,
      zIndex: 1,
    },
  },
  thumbnails: {
    height: 20,
    width: '100%',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    '& > div': {
      display: 'inline-block',
    },
  },
  ruler: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 28,
    padding: '0 8px',
    backgroundColor: '#151C20',
    color: Colors.lightGrey800,
    fontSize: 12,
    fontVariantNumeric: 'tabular-nums',
    pointerEvents: 'none',
    '@media (max-width: 480px)': { '& .secondary': { display: 'none' } },
  },
  rulerRemaining: {
    backgroundColor: 'rgba(0, 0, 0, 0.32)',
    position: 'absolute',
    top: 4,
    height: 44,
    pointerEvents: 'none',
  },
  playhead: {
    position: 'absolute',
    top: 0,
    bottom: 27,
    width: 2,
    backgroundColor: Colors.white,
    transform: 'translateX(-1px)',
    pointerEvents: 'none',
    zIndex: 2,
    '&:after': {
      content: '""',
      position: 'absolute',
      bottom: -3,
      left: -3,
      width: 8,
      height: 8,
      borderRadius: '50%',
      backgroundColor: 'inherit',
      boxShadow: '0 0 0 2px #151C20',
    },
  },
  hoverLine: {
    position: 'absolute',
    top: 4,
    height: 44,
    width: 1,
    backgroundColor: Colors.white60,
    pointerEvents: 'none',
  },
  dragHighlight: {
    pointerEvents: 'none',
    background: 'rgba(87, 169, 227, 0.25)',
    border: `1px solid ${Colors.lightBlue900}`,
    position: 'absolute',
    top: 0,
    height: 48,
  },
  hoverBead: {
    zIndex: 3,
    textAlign: 'center',
    borderRadius: 7,
    fontSize: 11,
    fontVariantNumeric: 'tabular-nums',
    padding: '5px 8px',
    border: `1px solid ${Colors.white10}`,
    backgroundColor: Colors.grey950,
    color: Colors.white,
    position: 'absolute',
    top: 8,
    left: 0,
    width: 144,
    pointerEvents: 'none',
    boxShadow: '0 2px 8px #00000040',
  },
});

const AlertStatusCodes = [
  'normal',
  'userPrompt',
  'critical',
];

function percentFromPointerEvent(ev) {
  const boundingBox = ev.currentTarget.getBoundingClientRect();
  const x = ev.clientX - boundingBox.left;
  return Math.max(0, Math.min(1, x / boundingBox.width));
}

class Timeline extends Component {
  constructor(props) {
    super(props);

    this.handleClick = this.handleClick.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.handlePointerLeave = this.handlePointerLeave.bind(this);
    this.seekToOffset = this.seekToOffset.bind(this);
    this.percentToOffset = this.percentToOffset.bind(this);
    this.onRulerRef = this.onRulerRef.bind(this);
    this.renderRoute = this.renderRoute.bind(this);

    this.rulerRef = React.createRef();
    this.thumbnailsRef = React.createRef();

    this.state = {
      dragging: null,
      hoverX: null,
      thumbnail: {
        height: 0,
        width: 0,
      },
    };
  }

  get zoom() {
    return this.props.zoomOverride || this.props.zoom;
  }

  componentDidMount() {
    if (typeof ResizeObserver !== 'undefined' && this.thumbnailsRef.current) {
      this.resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) {
          return;
        }
        const { width, height } = entry.contentRect;
        this.setState({ thumbnail: { width, height } });
      });
      this.resizeObserver.observe(this.thumbnailsRef.current);
    }
  }

  componentWillUnmount() {
    this.removeDragListeners();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }

  seekToOffset(offset) {
    this.props.dispatch(seek(offset));
  }

  handleKeyDown = (ev) => {
    const { offset } = this.props;
    const { zoom } = this;
    const target = { ArrowLeft: offset - 10000, ArrowDown: offset - 10000,
      ArrowRight: offset + 10000, ArrowUp: offset + 10000, Home: zoom.start, End: zoom.end }[ev.key];
    if (target === undefined) return;
    ev.preventDefault();
    this.seekToOffset(Math.max(zoom.start, Math.min(target, zoom.end)));
  };

  removeDragListeners() {
    document.removeEventListener('pointerup', this.handlePointerUp);
    document.removeEventListener('pointermove', this.handlePointerMove);
    document.removeEventListener('pointercancel', this.handlePointerCancel);
  }

  handlePointerCancel = () => {
    this.removeDragListeners();
    this.setState({ dragging: null, hoverX: null });
  };

  handleClick(ev) {
    const { dragging } = this.state;
    if (!dragging || Math.abs(dragging[1] - dragging[0]) <= 3) {
      const percent = percentFromPointerEvent(ev);
      const offset = this.percentToOffset(percent);
      this.seekToOffset(offset);
    }
  }

  handlePointerDown(ev) {
    if (ev.button !== 0) {
      return;
    }

    ev.preventDefault();
    this.rulerRef.current.focus();
    document.addEventListener('pointerup', this.handlePointerUp);
    document.addEventListener('pointermove', this.handlePointerMove);
    document.addEventListener('pointercancel', this.handlePointerCancel);
    this.setState({ dragging: [ev.clientX, ev.clientX] });
  }

  handlePointerMove(ev) {
    ev.preventDefault();
    const { dragging } = this.state;
    if (!this.rulerRef.current) {
      return;
    }
    const rulerBounds = this.rulerRef.current.getBoundingClientRect();
    const endDrag = Math.max(rulerBounds.x, Math.min(rulerBounds.x + rulerBounds.width, ev.clientX));
    if (dragging) {
      this.setState({ dragging: [dragging[0], endDrag] });
    }
    this.setState({ hoverX: endDrag });
  }

  handlePointerUp(ev) {
    const { offset, route } = this.props;

    // prevent preventDefault for back(3) and forward(4) mouse buttons
    if (ev.button !== 3 && ev.button !== 4) {
      ev.preventDefault();
    }

    this.removeDragListeners();
    const { dragging } = this.state;
    if (!dragging) {
      return;
    }
    this.setState({ dragging: null });

    const rulerBounds = this.rulerRef.current.getBoundingClientRect();
    const startPercent = (Math.min(dragging[0], dragging[1]) - rulerBounds.x) / rulerBounds.width;
    const endPercent = (Math.max(dragging[0], dragging[1]) - rulerBounds.x) / rulerBounds.width;
    const startOffset = Math.round(this.percentToOffset(startPercent));
    const endOffset = Math.round(this.percentToOffset(endPercent));

    if (Math.abs(dragging[1] - dragging[0]) > 3) {
      if (offset < startOffset || offset > endOffset) {
        this.seekToOffset(startOffset);
      }
      const { dispatch } = this.props;
      const startTime = startOffset;
      const endTime = endOffset;

      dispatch(pushTimelineRange(route.log_id, startTime, endTime, true));
    } else if (ev.currentTarget !== document) {
      this.handleClick(ev);
    }
  }

  handlePointerLeave() {
    this.setState({ hoverX: null });
  }

  onRulerRef(el) {
    this.rulerRef.current = el;
    if (el) {
      el.addEventListener('touchstart', (ev) => ev.stopPropagation());
    }
  }

  percentToOffset(perc) {
    const { zoom } = this;
    return perc * (zoom.end - zoom.start) + zoom.start;
  }

  offsetToPercent(offset) {
    const { zoom } = this;
    return (offset - zoom.start) / (zoom.end - zoom.start);
  }

  renderRoute() {
    const { classes, route } = this.props;
    const { zoom } = this;

    if (!route.events) {
      return null;
    }

    const zoomDuration = zoom.end - zoom.start;
    const startPerc = (100 * (-zoom.start)) / zoomDuration;
    const widthPerc = (100 * route.duration) / zoomDuration;

    const style = {
      width: `${widthPerc}%`,
      left: `${startPerc}%`,
    };
    return (
      <div key={route.fullname} className={classes.segment} style={style}>
        { this.renderRouteEvents(route) }
      </div>
    );
  }

  renderRouteEvents(route) {
    const { classes } = this.props;
    if (!route.events) {
      return null;
    }

    return route.events
      .filter((event) => event.data && event.data.end_route_offset_millis)
      .map((event) => {
        const style = {
          left: `${(event.route_offset_millis / route.duration) * 100}%`,
          width: `${((event.data.end_route_offset_millis - event.route_offset_millis) / route.duration) * 100}%`,
          minWidth: '1px',
        };
        const statusCls = event.data.alertStatus ? `${AlertStatusCodes[event.data.alertStatus]}` : '';
        return (
          <div
            key={route.fullname + event.route_offset_millis + event.type}
            style={style}
            className={ `${classes.segmentColor} ${event.type} ${statusCls}` }
          />
        );
      });
  }

  render() {
    const { classes, hasRuler, className, route, thumbnailsVisible } = this.props;
    const { thumbnail, hoverX, dragging } = this.state;
    const { zoom } = this;

    const hasRulerCls = hasRuler ? 'hasRuler' : '';

    let rulerBounds;
    if (this.rulerRef.current) {
      rulerBounds = this.rulerRef.current.getBoundingClientRect();
    }

    let hoverString; let
      hoverStyle;
    if (rulerBounds && hoverX !== null) {
      const hoverOffset = this.percentToOffset((hoverX - rulerBounds.x) / rulerBounds.width);
      hoverStyle = { left: Math.max(4, Math.min(rulerBounds.width - 148, hoverX - rulerBounds.x - 72)) };
      if (!Number.isNaN(hoverOffset)) {
        const selection = dragging?.map((x) => this.percentToOffset((x - rulerBounds.x) / rulerBounds.width)).sort((a, b) => a - b);
        hoverString = dragging && Math.abs(dragging[1] - dragging[0]) > 3
          ? `Loop ${formatPlaybackTime(selection[0])} – ${formatPlaybackTime(selection[1])}`
          : `${formatPlaybackTime(hoverOffset)} · ${dayjs(route.start_time_utc_millis + hoverOffset).format('HH:mm:ss')}`;
      }
    }

    let draggerStyle;
    if (rulerBounds && dragging && Math.abs(dragging[1] - dragging[0]) > 0) {
      draggerStyle = {
        left: `${Math.min(dragging[1], dragging[0]) - rulerBounds.x}px`,
        width: `${Math.abs(dragging[1] - dragging[0])}px`,
      };
    }

    const baseWidthStyle = { width: '100%' };
    const playedPercent = Math.max(0, Math.min(100, 100 * this.offsetToPercent(this.props.offset)));

    return (
      <div className={className}>
        <div
          role={hasRuler ? 'slider' : 'presentation'}
          aria-label={hasRuler ? 'Drive timeline' : undefined}
          aria-valuemin={hasRuler ? zoom.start / 1000 : undefined}
          aria-valuemax={hasRuler ? zoom.end / 1000 : undefined}
          aria-valuenow={hasRuler ? this.props.offset / 1000 : undefined}
          aria-valuetext={hasRuler ? `${Math.round(this.props.offset / 1000)} seconds into drive` : undefined}
          title={hasRuler ? 'Click to seek · Drag to loop · Arrow keys skip 10 seconds' : undefined}
          tabIndex={hasRuler ? 0 : undefined}
          ref={hasRuler ? this.onRulerRef : undefined}
          onPointerDown={hasRuler ? this.handlePointerDown : undefined}
          onPointerUp={hasRuler ? this.handlePointerUp : undefined}
          onPointerMove={hasRuler ? this.handlePointerMove : undefined}
          onPointerLeave={hasRuler ? this.handlePointerLeave : undefined}
          onKeyDown={hasRuler ? this.handleKeyDown : undefined}
          className={`${classes.base} ${hasRulerCls}`}
          style={baseWidthStyle}
        >
          <div className={ `${classes.segments} ${hasRulerCls}` }>
            { route && this.renderRoute() }
            <div className={ `${classes.statusGradient} ${hasRulerCls}` } />
          </div>
          <div ref={this.thumbnailsRef} className={`${classes.thumbnails} ${hasRulerCls}`}>
            {thumbnailsVisible && (
              <Thumbnails
                className={classes.thumbnail}
                currentRoute={route}
                percentToOffset={this.percentToOffset}
                thumbnail={thumbnail}
                hasRuler={hasRuler}
              />
            )}
          </div>
          { hasRuler && (
            <>
              <div className={classes.ruler} aria-hidden="true">
                {[0, 0.25, 0.5, 0.75, 1].map((fraction, index) => (
                  <span key={fraction} className={index % 2 ? 'secondary' : undefined}>
                    {formatPlaybackTime(zoom.start + fraction * (zoom.end - zoom.start))}
                  </span>
                ))}
              </div>
              <div className={classes.rulerRemaining} style={{ left: `${playedPercent}%`, width: `${100 - playedPercent}%` }} />
              <div className={classes.playhead} style={{ left: `${playedPercent}%` }} />
              {rulerBounds && hoverX !== null && <div className={classes.hoverLine} style={{ left: hoverX - rulerBounds.x }} />}
              {draggerStyle && <div className={classes.dragHighlight} style={draggerStyle} />}
              { hoverString && (
                <div className={classes.hoverBead} style={hoverStyle}>
                  { hoverString }
                </div>
              ) }
            </>
          ) }
        </div>
      </div>
    );
  }
}

const stateToProps = (state, { hasRuler }) => ({
  offset: hasRuler ? state.offset : 0,
  zoom: state.zoom,
});

export default connect(stateToProps)(withStyles(styles)(Timeline));
