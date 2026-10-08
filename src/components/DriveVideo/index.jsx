import React, { Component } from 'react';
import { connect } from 'react-redux';
import { Button, CircularProgress, Typography } from '@material-ui/core';

import { api } from '../../api/backend';
import { ErrorOutline } from '../../icons';
import { VideoStatus, pause, play, resetPlayback, setHasAudio, setPlaybackSpeed, setVideoStatus, videoProgress } from '../../timeline/playback';
import { openStream } from './stream';

const NO_VIDEO = 'No video is available in this selection.';

class RouteVideo extends Component {
  video = React.createRef();
  state = { error: null };
  sourceId = 0;
  playAttempt = 0;

  componentDidMount() {
    this.mounted = true;
    this.props.dispatch(resetPlayback());
    this.video.current.audioTracks?.addEventListener?.('addtrack', this.detectAudio);
    this.loadSource();
  }

  componentDidUpdate(prevProps) {
    const { seekRequest, loop, currentRoute, isPlaying, desiredPlaySpeed } = this.props;
    if (currentRoute.share_exp !== prevProps.currentRoute.share_exp || currentRoute.share_sig !== prevProps.currentRoute.share_sig) {
      this.loadSource();
    } else if (seekRequest !== prevProps.seekRequest || loop !== prevProps.loop
      || currentRoute.videoStartOffset !== prevProps.currentRoute.videoStartOffset) {
      this.seekTo(this.props.offset);
    }
    if (isPlaying !== prevProps.isPlaying || desiredPlaySpeed !== prevProps.desiredPlaySpeed) {
      this.applyPlayback();
    }
  }

  componentWillUnmount() {
    this.mounted = false;
    this.sourceId += 1;
    this.playAttempt += 1;
    cancelAnimationFrame(this.frameId);
    this.video.current.audioTracks?.removeEventListener?.('addtrack', this.detectAudio);
    this.stream?.destroy();
  }

  loadSource = () => {
    this.sourceId += 1;
    const sourceId = this.sourceId;
    this.playAttempt += 1;
    this.playPending = false;
    this.loading = true;
    this.pendingSeek = true;
    this.failed = false;
    this.streamError = null;
    this.ready = false;
    this.stream?.destroy();
    this.setState({ error: null });
    this.setStatus(VideoStatus.LOADING);
    const { currentRoute } = this.props;
    const url = api.video.getQcameraStreamUrl(currentRoute.fullname, currentRoute.share_exp, currentRoute.share_sig);
    const active = () => this.mounted && this.sourceId === sourceId;
    this.stream = openStream(this.video.current, url, {
      startPosition: this.seekPosition(),
      onError: (error) => { if (active()) this.onStreamError(error); },
      onAudio: () => { if (active()) this.props.dispatch(setHasAudio(true)); },
    });
  };

  setStatus(status) {
    if (this.props.videoStatus !== status) this.props.dispatch(setVideoStatus(status));
  }

  // Route time includes the log prefix before the first video frame.
  range() {
    const { currentRoute, loop } = this.props;
    const firstFrame = currentRoute.videoStartOffset || 0;
    const duration = this.video.current.duration;
    const mediaEnd = Number.isFinite(duration) ? firstFrame + duration * 1000 : Infinity;
    return [Math.max(loop?.startTime ?? 0, firstFrame),
      Math.min(loop ? loop.startTime + loop.duration : currentRoute.duration, mediaEnd)];
  }

  seekPosition(offset = this.props.offset) {
    const [start, end] = this.range();
    return (Math.max(start, Math.min(offset ?? start, end)) - (this.props.currentRoute.videoStartOffset || 0)) / 1000;
  }

  isBuffered(time) {
    const { buffered } = this.video.current;
    for (let index = 0; index < buffered.length; index += 1) {
      if (time >= buffered.start(index) && time <= buffered.end(index)) return true;
    }
    return false;
  }

  seekTo(offset) {
    if (this.failed) {
      this.loadSource();
      return;
    }
    if (!this.ready) {
      this.stream?.seek(this.seekPosition(offset));
      return;
    }
    const [start, end] = this.range();
    if (!(end > start)) {
      this.onError({ message: NO_VIDEO });
      this.props.dispatch(pause());
      return;
    }
    const video = this.video.current;
    const target = this.seekPosition(offset);
    this.pendingSeek = video.currentTime !== target;
    if (this.pendingSeek) video.currentTime = target;
    if (this.streamError && !this.isBuffered(target)) {
      this.streamError = null;
      this.stream.seek(target);
    }
    if (!this.pendingSeek) this.updateOffset();
  }

  async applyPlayback() {
    const video = this.video.current;
    if (!this.props.isPlaying || this.failed) {
      this.playAttempt += 1;
      this.playPending = false;
      video.pause();
      return;
    }
    if (!this.ready) return;
    if (video.playbackRate !== this.props.desiredPlaySpeed) video.playbackRate = this.props.desiredPlaySpeed;
    const [start, end] = this.range();
    const offset = video.currentTime * 1000 + (this.props.currentRoute.videoStartOffset || 0);
    if (offset < start || offset >= end) this.seekTo(start);
    if (this.failed || !video.paused || this.playPending) return;
    this.playAttempt += 1;
    const attempt = this.playAttempt;
    this.playPending = true;
    try {
      await video.play();
    } catch (error) {
      if (this.mounted && attempt === this.playAttempt) this.onError(error);
    } finally {
      if (attempt === this.playAttempt) this.playPending = false;
    }
  }

  onLoadedMetadata = () => {
    if (!this.mounted) return;
    this.ready = true;
    this.seekTo(this.props.offset);
    this.detectAudio();
    this.applyPlayback();
  };

  onPlayable = () => {
    if (!this.mounted || this.failed) return;
    this.loading = false;
    this.setStatus(VideoStatus.READY);
    this.detectAudio();
    this.applyPlayback();
  };

  onSeeking = () => {
    if (!this.mounted) return;
    this.pendingSeek = true;
    if (!this.failed) this.setStatus(VideoStatus.LOADING);
  };

  onWaiting = () => {
    if (!this.mounted || this.failed) return;
    const video = this.video.current;
    const [start, end] = this.range().map((time) => (time - (this.props.currentRoute.videoStartOffset || 0)) / 1000);
    const fragment = this.streamError?.frag;
    if (fragment && !this.pendingSeek && !video.seeking && fragment.start < end && fragment.start + fragment.duration > start) {
      this.onError(this.streamError);
    } else this.setStatus(VideoStatus.LOADING);
  };

  onSeeked = () => {
    if (!this.mounted) return;
    this.pendingSeek = false;
    if (this.video.current.readyState >= 2) this.onPlayable();
    this.updateOffset();
  };

  onPlaying = () => {
    if (!this.mounted || this.failed || this.video.current.paused) return;
    if (!this.props.isPlaying) this.props.dispatch(play());
    this.onPlayable();
    cancelAnimationFrame(this.frameId);
    this.onFrame();
  };

  onPause = () => {
    if (!this.mounted) return;
    cancelAnimationFrame(this.frameId);
    this.updateOffset();
    const video = this.video.current;
    if (video.paused && !video.ended && !this.loading && !this.failed && this.props.isPlaying) {
      this.props.dispatch(pause());
    }
  };

  onEnded = () => {
    if (!this.mounted) return;
    if (this.props.isPlaying && this.props.loop?.duration > 0) {
      this.seekTo(this.range()[0]);
      this.applyPlayback();
    } else {
      this.updateOffset();
      this.props.dispatch(pause());
    }
  };

  onFrame = () => {
    this.updateOffset();
    if (this.mounted && !this.video.current.paused && !this.failed) {
      this.frameId = requestAnimationFrame(this.onFrame);
    }
  };

  updateOffset = () => {
    const video = this.video.current;
    if (!this.mounted || !this.ready || this.failed || this.pendingSeek || video.seeking) return;
    const { currentRoute, isPlaying, loop, dispatch, offset } = this.props;
    const nextOffset = Math.round(video.currentTime * 1000) + (currentRoute.videoStartOffset || 0);
    const [start, end] = this.range();
    if (isPlaying && loop?.duration > 0 && (nextOffset < start || nextOffset >= end)) {
      this.seekTo(start);
      return;
    }
    if (nextOffset !== offset) {
      if (!video.paused && video.readyState >= 2 && this.props.videoStatus === VideoStatus.LOADING) this.onPlayable();
      dispatch(videoProgress(nextOffset));
    }
  };

  detectAudio = () => {
    if (!this.mounted) return;
    const video = this.video.current;
    if (video.audioTracks?.length || video.mozHasAudio || video.webkitAudioDecodedByteCount > 0) {
      this.props.dispatch(setHasAudio(true));
    }
  };

  onStreamError(error) {
    const video = this.video.current;
    // A failed prefetch must not interrupt usable frames or a buffered loop.
    // HLS has stopped loading; a later unbuffered seek explicitly restarts it.
    if (error?.frag?.duration > 0 && Number.isFinite(error.frag.start)
      && video.readyState >= 3 && !video.seeking && this.isBuffered(video.currentTime)) {
      this.streamError = error;
    } else this.onError(error);
  }

  onError = (error) => {
    if (!this.mounted || error?.name === 'AbortError') return;
    if (error?.name === 'NotAllowedError') {
      this.props.dispatch(pause());
      this.setStatus(VideoStatus.READY);
      return;
    }
    this.failed = true;
    this.pendingSeek = false;
    this.setStatus(VideoStatus.FAILED);
    this.video.current.pause();
    this.setState({ error: error?.message === NO_VIDEO ? NO_VIDEO
      : error?.response?.code === 404 ? 'This video segment has not uploaded yet or has been deleted.'
        : 'Unable to load video. Check your connection or try another segment.' });
  };

  render() {
    const { isMuted, videoStatus } = this.props;
    const { error } = this.state;
    return (
      <div className="min-h-[200px] relative max-w-[964px] m-[0_auto] aspect-[1.593] bg-black">
        <video
          ref={this.video}
          className="block h-full w-full"
          aria-label="Drive video"
          playsInline
          muted={isMuted}
          preload="auto"
          onLoadedMetadata={this.onLoadedMetadata}
          onCanPlay={this.onPlayable}
          onTimeUpdate={this.updateOffset}
          onSeeking={this.onSeeking}
          onSeeked={this.onSeeked}
          onPlaying={this.onPlaying}
          onPause={this.onPause}
          onEnded={this.onEnded}
          onWaiting={this.onWaiting}
          onRateChange={(event) => {
            const rate = event.currentTarget.playbackRate;
            if (this.mounted && this.ready && rate > 0 && rate !== this.props.desiredPlaySpeed) this.props.dispatch(setPlaybackSpeed(rate));
          }}
          onError={this.onError}
        />
        {(error || videoStatus === VideoStatus.LOADING) && (
          <div className={`absolute inset-0 z-[70] pointer-events-none flex items-center justify-center bg-[#16181AAA] text-center ${error ? '' : 'animate-[drive-video-loading_150ms_ease-out_200ms_both]'}`} role="status">
            {error ? <div className="p-4 pointer-events-auto">
              <ErrorOutline className="mb-2" />
              <Typography>{error}</Typography>
              {error === NO_VIDEO ? <Typography>Choose another range on the timeline.</Typography>
                : <Button onClick={this.loadSource} style={{ color: 'white', marginTop: 8 }}>Retry</Button>}
            </div> : <CircularProgress style={{ color: 'white' }} thickness={4} size={50} aria-label="Loading video" />}
          </div>
        )}
      </div>
    );
  }
}

const DriveVideo = (props) => props.currentRoute ? <RouteVideo
  key={props.currentRoute.fullname}
  {...props}
/> : null;

export default connect((state) => ({
  currentRoute: state.currentRoute,
  offset: state.offset,
  seekRequest: state.seekRequest,
  loop: state.loop,
  isPlaying: state.isPlaying,
  desiredPlaySpeed: state.desiredPlaySpeed,
  videoStatus: state.videoStatus,
}))(DriveVideo);
