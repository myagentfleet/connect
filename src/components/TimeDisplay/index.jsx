import React, { Component } from 'react';
import { connect } from 'react-redux';
import dayjs from 'dayjs';

import { withStyles } from '@material-ui/core/styles';
import Typography from '@material-ui/core/Typography';
import IconButton from '@material-ui/core/IconButton';
import { Tooltip } from '@material-ui/core';

import { Forward10, Pause, PlayArrow, Replay10, VolumeUp, VolumeOff } from '../../icons';
import { currentOffset } from '../../timeline';
import { seek, play, pause } from '../../timeline/playback';
import { getSegmentNumber } from '../../utils';
import { isIos } from '../../utils/browser.js';
import './index.css';

const timerSteps = [0.1, 0.25, 0.5, 1, 2, 4, 8];

const styles = (theme) => ({
  base: {
    backgroundColor: theme.palette.grey[950],
    border: '1px solid rgba(255, 255, 255, 0.1)',
    borderRadius: 16,
    padding: theme.spacing.unit,
    width: 400,
    maxWidth: '100%',
    margin: '0 auto',
    opacity: 0,
    pointerEvents: 'none',
    transition: 'opacity 0.1s ease-in-out',
    '&.isExpanded': {
      opacity: 1,
      pointerEvents: 'auto',
    },
  },
  icon: {
    width: 24,
    height: 24,
  },
  iconButton: {
    width: 44,
    height: 44,
    justifySelf: 'center',
    color: theme.palette.grey[100],
    '&:focus-visible': {
      outline: '2px solid #007cbf',
      outlineOffset: 2,
    },
  },
  playButton: {
    backgroundColor: theme.palette.grey[800],
    color: '#fff',
    '&:hover': {
      backgroundColor: theme.palette.grey[700],
    },
  },
  currentTime: {
    fontSize: 14,
    lineHeight: '20px',
    fontWeight: 500,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    display: 'block',
  },
  audioControl: {
    display: 'flex',
    justifyContent: 'center',
  },
  speedSelect: {
    width: '100%',
    minWidth: 0,
    height: 44,
    padding: '0 2px',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    borderRadius: 8,
    backgroundColor: 'transparent',
    color: '#fff',
    fontSize: 12,
    fontFamily: 'inherit',
    fontVariantNumeric: 'tabular-nums',
    cursor: 'pointer',
    '&:focus-visible': {
      outline: '2px solid #007cbf',
      outlineOffset: 2,
    },
    '& option': {
      backgroundColor: theme.palette.grey[900],
    },
  },
});

class TimeDisplay extends Component {
  static getDerivedStateFromProps(props, state) {
    if (props.desiredPlaySpeed !== 0 && props.desiredPlaySpeed !== state.desiredPlaySpeed) {
      return { desiredPlaySpeed: props.desiredPlaySpeed };
    }
    return null;
  }

  constructor(props) {
    super(props);

    this.textHolder = React.createRef();
    this.updateTime = this.updateTime.bind(this);
    this.togglePause = this.togglePause.bind(this);
    this.changeSpeed = this.changeSpeed.bind(this);
    this.jumpBack = this.jumpBack.bind(this);
    this.jumpForward = this.jumpForward.bind(this);

    this.state = {
      desiredPlaySpeed: 1,
      displayTime: this.getDisplayTime(),
    };
  }

  componentDidMount() {
    this.mounted = true;
    requestAnimationFrame(this.updateTime);
  }

  componentWillUnmount() {
    this.mounted = false;
  }

  getDisplayTime() {
    const offset = currentOffset();
    const { currentRoute } = this.props;
    const now = new Date(offset + currentRoute.start_time_utc_millis);
    if (Number.isNaN(now.getTime())) return '...';
    let dateString = dayjs(now).format('HH:mm:ss');
    const seg = getSegmentNumber(currentRoute);
    if (seg !== null) dateString = dateString + ' \u2013 ' + seg;
    return dateString;
  }

  jumpBack(amount) {
    this.props.dispatch(seek(currentOffset() - amount));
  }

  jumpForward(amount) {
    this.props.dispatch(seek(currentOffset() + amount));
  }

  updateTime() {
    if (!this.mounted || !this.textHolder.current) return;
    const displayTime = this.getDisplayTime();
    if (displayTime !== this.state.displayTime) this.setState({ displayTime });
    requestAnimationFrame(this.updateTime);
  }

  changeSpeed(event) {
    const speed = Number(event.target.value);
    if (!timerSteps.includes(speed)) return;
    if (this.props.desiredPlaySpeed === 0) {
      this.setState({ desiredPlaySpeed: speed });
    } else {
      this.props.dispatch(play(speed));
    }
  }

  togglePause() {
    const { desiredPlaySpeed, dispatch } = this.props;
    dispatch(desiredPlaySpeed === 0 ? play(this.state.desiredPlaySpeed) : pause());
  }

  render() {
    const { classes, zoom, desiredPlaySpeed: videoPlaySpeed, isThin, onMuteToggle, isMuted, hasAudio } = this.props;
    const { displayTime, desiredPlaySpeed } = this.state;
    const isPaused = videoPlaySpeed === 0;
    const groupClasses = ['PlaybackControls', classes.base, zoom ? 'isExpanded' : '', isIos() ? 'isIos' : ''].join(' ');

    return (
      <div className="PlaybackControlsContainer">
        <div className={groupClasses} role="group" aria-label="Playback controls">
          <IconButton className={classes.iconButton} onClick={() => this.jumpBack(10000)} aria-label="Jump back 10 seconds">
            <Replay10 className={classes.icon} />
          </IconButton>
          <IconButton className={classes.iconButton} onClick={() => this.jumpForward(10000)} aria-label="Jump forward 10 seconds">
            <Forward10 className={classes.icon} />
          </IconButton>
          <div className="PlaybackControlsTime">
            {!isThin && <Typography variant="caption" align="center">CURRENT PLAYBACK TIME</Typography>}
            <Typography variant="body1" align="center" className={classes.currentTime}>
              <span ref={this.textHolder}>{displayTime}</span>
            </Typography>
          </div>
          {!isIos() && (
            <select className={classes.speedSelect} aria-label="Playback speed" value={desiredPlaySpeed} onChange={this.changeSpeed}>
              {timerSteps.map((speed) => (
                <option key={speed} value={speed}>{String(speed).replace(/^0\./, '.')}×</option>
              ))}
            </select>
          )}
          <Tooltip title={!hasAudio ? 'Enable audio recording through the "Record and Upload Microphone Audio" toggle on your device' : ''}>
            <div className={classes.audioControl}>
              <IconButton className={classes.iconButton} onClick={onMuteToggle} disabled={!hasAudio} aria-label={isMuted ? 'Unmute' : 'Mute'}>
                {isMuted ? <VolumeOff className={classes.icon} /> : <VolumeUp className={classes.icon} />}
              </IconButton>
            </div>
          </Tooltip>
          <IconButton className={[classes.iconButton, classes.playButton].join(' ')} onClick={this.togglePause} aria-label={isPaused ? 'Unpause' : 'Pause'}>
            {isPaused ? <PlayArrow className={classes.icon} /> : <Pause className={classes.icon} />}
          </IconButton>
        </div>
      </div>
    );
  }
}

const stateToProps = (state) => ({
  currentRoute: state.currentRoute,
  zoom: state.zoom,
  desiredPlaySpeed: state.desiredPlaySpeed,
});

export default connect(stateToProps)(withStyles(styles)(TimeDisplay));
