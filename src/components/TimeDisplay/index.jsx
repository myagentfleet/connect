import React, { Component } from 'react';
import { connect } from 'react-redux';
import dayjs from 'dayjs';

import { withStyles } from '@material-ui/core/styles';
import { IconButton, Menu, MenuItem, Tooltip } from '@material-ui/core';

import { DownArrow, Forward10, Pause, PlayArrow, Replay10, VolumeUp, VolumeOff } from '../../icons';
import { seek, play, pause, setPlaybackSpeed } from '../../timeline/playback';
import { formatPlaybackTime, getSegmentNumber } from '../../utils';
import { isIos } from '../../utils/browser.js';

const styles = (theme) => ({
  base: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    width: '100%',
    boxSizing: 'border-box',
    padding: 8,
    backgroundColor: theme.palette.grey[950],
    borderTop: '1px solid rgba(255,255,255,0.1)',
    fontVariantNumeric: 'tabular-nums',
  },
  time: {
    flex: '1 1 165px',
    minWidth: 0,
    padding: '0 4px',
  },
  elapsed: {
    color: theme.palette.common.white,
    fontSize: 14,
    fontWeight: 600,
    lineHeight: '22px',
    '& span': { color: 'rgba(255,255,255,0.6)', fontWeight: 400 },
  },
  recorded: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    lineHeight: '18px',
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    flex: '0 0 244px',
    marginLeft: 'auto',
  },
  button: {
    width: 44,
    height: 44,
    flexShrink: 0,
    padding: 10,
    borderRadius: 12,
    color: theme.palette.common.white,
    transition: 'background-color 120ms ease, transform 120ms ease',
    '&:active': { backgroundColor: theme.palette.grey[700], transform: 'scale(0.94)' },
    '&&:focus-visible': { outline: '2px solid white', outlineOffset: -3 },
    '@media (hover: hover)': { '&:hover': { backgroundColor: theme.palette.grey[800] } },
    '@media (prefers-reduced-motion: reduce)': { transition: 'none', '&:active': { transform: 'none' } },
    '& svg': { width: 24, height: 24 },
  },
  play: {
    borderRadius: '50%',
    color: theme.palette.grey[999],
    backgroundColor: theme.palette.common.white,
    '&:active': { backgroundColor: '#c4cbd0' },
    '&&:focus-visible': { outlineColor: theme.palette.grey[999] },
    '@media (hover: hover)': { '&:hover': { backgroundColor: '#e5e9ec' } },
  },
  speed: {
    width: 56,
    padding: 4,
    '& > span': { gap: 4 },
    border: '1px solid rgba(255,255,255,0.15)',
    fontSize: 12,
    fontWeight: 600,
    '& svg': { width: 10, height: 10 },
  },
  speedMenu: { borderRadius: 12, minWidth: 120, border: '1px solid rgba(255,255,255,0.15)' },
  speedItem: {
    minHeight: 44,
    boxSizing: 'border-box',
    fontVariantNumeric: 'tabular-nums',
    '&[aria-checked="true"]': { color: theme.palette.common.white, fontWeight: 700, backgroundColor: theme.palette.grey[800] },
    '&:hover, &:focus': { backgroundColor: theme.palette.grey[700] },
    '&&:focus-visible': { outline: '2px solid white', outlineOffset: -3 },
  },
});

class TimeDisplay extends Component {
  state = { speedAnchor: null };

  componentDidUpdate(prevProps) {
    if (prevProps.currentRoute?.fullname !== this.props.currentRoute?.fullname && this.state.speedAnchor) {
      this.closeSpeedMenu();
    }
  }

  closeSpeedMenu = () => this.setState({ speedAnchor: null });

  getDisplayTime() {
    const { currentRoute, offset } = this.props;
    const now = new Date(offset + currentRoute?.start_time_utc_millis);
    if (Number.isNaN(now.getTime())) return 'Recorded time unavailable';
    const segment = getSegmentNumber(currentRoute, offset);
    return `Recorded ${dayjs(now).format('HH:mm:ss')}${segment === null ? '' : ` · Segment ${segment}`}`;
  }

  render() {
    const { classes, zoom, currentRoute, onMuteToggle, isMuted, hasAudio, desiredPlaySpeed, isPlaying, dispatch, offset } = this.props;
    const { speedAnchor } = this.state;
    const start = zoom?.start ?? 0;
    const duration = Math.max(0, (zoom?.end ?? currentRoute?.duration ?? 0) - start);
    const elapsed = Math.max(0, Math.min(offset - start, duration));
    const timerSteps = isIos() ? [0.5, 1, 2] : [0.1, 0.25, 0.5, 1, 2, 4, 8];

    return (
      <div className={classes.base} role="group" aria-label="Playback controls">
        <div className={classes.time}>
          <div className={classes.elapsed} aria-label="Selection playback time">
            {formatPlaybackTime(elapsed)} <span>/ {formatPlaybackTime(duration)}</span>
          </div>
          <div className={classes.recorded}>{this.getDisplayTime()}</div>
        </div>
        <div className={classes.controls}>
          <IconButton className={classes.button} onClick={() => dispatch(seek(offset - 10000))} aria-label="Jump back 10 seconds">
            <Replay10 />
          </IconButton>
          <IconButton className={`${classes.button} ${classes.play}`} onClick={() => dispatch(isPlaying ? pause() : play())} aria-label={isPlaying ? 'Pause' : 'Play'}>
            {isPlaying ? <Pause /> : <PlayArrow />}
          </IconButton>
          <IconButton className={classes.button} onClick={() => dispatch(seek(offset + 10000))} aria-label="Jump forward 10 seconds">
            <Forward10 />
          </IconButton>
          <IconButton
            className={`${classes.button} ${classes.speed}`}
            onClick={(event) => this.setState({ speedAnchor: event.currentTarget })}
            aria-label="Playback speed"
            aria-haspopup="menu"
            aria-expanded={Boolean(speedAnchor)}
            aria-controls={speedAnchor ? 'playback-speed-menu' : undefined}
          >
            {desiredPlaySpeed}× <DownArrow />
          </IconButton>
          <Tooltip title={!hasAudio ? 'Enable audio recording through the "Record and Upload Microphone Audio" toggle on your device' : ''}>
            <IconButton className={classes.button} onClick={onMuteToggle} aria-label={isMuted ? 'Unmute' : 'Mute'}>
              {isMuted ? <VolumeOff /> : <VolumeUp />}
            </IconButton>
          </Tooltip>
        </div>
        <Menu
          open={Boolean(speedAnchor)}
          anchorEl={speedAnchor}
          onClose={this.closeSpeedMenu}
          getContentAnchorEl={null}
          anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
          transformOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          transitionDuration={0}
          classes={{ paper: classes.speedMenu }}
          MenuListProps={{ id: 'playback-speed-menu', 'aria-label': 'Playback speed' }}
        >
          {timerSteps.map((speed) => (
            <MenuItem
              key={speed}
              className={classes.speedItem}
              role="menuitemradio"
              selected={speed === desiredPlaySpeed}
              aria-checked={speed === desiredPlaySpeed}
              onClick={() => { dispatch(setPlaybackSpeed(speed)); this.closeSpeedMenu(); }}
            >
              {speed}×
            </MenuItem>
          ))}
        </Menu>
      </div>
    );
  }
}

const stateToProps = (state) => ({
  currentRoute: state.currentRoute,
  zoom: state.zoom,
  desiredPlaySpeed: state.desiredPlaySpeed,
  isPlaying: state.isPlaying,
  offset: state.offset,
});

export default connect(stateToProps)(withStyles(styles)(TimeDisplay));
