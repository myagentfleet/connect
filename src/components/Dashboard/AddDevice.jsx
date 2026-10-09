import React, { Component } from 'react';
import { connect } from 'react-redux';
import localforage from 'localforage';
import { BarcodeDetector } from 'barcode-detector/ponyfill';
import { withStyles, Typography, Button, Modal, Paper, CircularProgress } from '@material-ui/core';
import * as Sentry from '@sentry/react';

import { api } from '../../api/backend';
import { selectDevice, updateDevices, analyticsEvent } from '../../actions';
import { openDialog } from '../../actions/navigation';
import { verifyPairToken, pairErrorToMessage } from '../../utils';
import { AddCircleOutlineIcon } from '../../icons';
import Colors from '../../colors';

// A token URL represents one transaction per app store. Back/Forward may remount
// its dialog, but must not repeat a pairing that is pending or already finished.
const urlPairings = new WeakMap();
const deviceRefreshes = new WeakMap();

async function forgetStoredToken(pairToken) {
  try {
    if (await localforage.getItem('pairToken') === pairToken) {
      await localforage.removeItem('pairToken');
    }
  } catch (err) {
    console.error(err);
  }
}

async function performPairing(pairToken, fromUrl, method, dispatch) {
  const tokenLink = method === 'url_string';
  try {
    verifyPairToken(pairToken, fromUrl, tokenLink ? 'explorer_pair_verify_pairtoken' : 'adddevice_verify_pairtoken');
  } catch (err) {
    return { pairDongleId: null, pairError: `Error: ${err.message}` };
  }

  let response;
  try {
    response = await api.devices.pilotPair(pairToken);
  } catch (err) {
    const message = pairErrorToMessage(err, tokenLink ? 'explorer_pair_pairtoken' : 'adddevice_pair_qr');
    return { pairDongleId: null, pairError: `Error: ${message}${tokenLink ? ', please try again' : ''}` };
  }

  if (!response?.dongle_id) {
    if (tokenLink) console.log(response);
    else Sentry.captureMessage('qr scan failed', { extra: { resp: response } });
    return { pairDongleId: null, pairError: `Error: could not pair${tokenLink ? ', please try again' : ''}` };
  }

  dispatch(analyticsEvent('pair_device', { method }));
  const refresh = {};
  deviceRefreshes.set(dispatch, refresh);
  try {
    const devices = await api.devices.listDevices();
    // An earlier pairing's delayed snapshot must not remove a newer device.
    if (deviceRefreshes.get(dispatch) === refresh) dispatch(updateDevices(devices));
  } catch (err) {
    // Pairing has succeeded even if refreshing the account's device list fails.
    Sentry.captureException(err, { fingerprint: 'adddevice_pair_refresh_devices' });
  }
  return { pairDongleId: response.dongle_id, pairError: null };
}

function pairFromUrl(pairToken, dispatch) {
  if (!urlPairings.has(dispatch)) urlPairings.set(dispatch, new Map());
  const transactions = urlPairings.get(dispatch);
  if (!transactions.has(pairToken)) {
    forgetStoredToken(pairToken);
    transactions.set(pairToken, performPairing(pairToken, true, 'url_string', dispatch));
  }
  return transactions.get(pairToken);
}

const styles = (theme) => ({
  titleContainer: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 5,
  },
  addButton: {
    width: '100%',
    background: Colors.white,
    borderRadius: 18,
    color: Colors.grey900,
    textTransform: 'none',
    '&:hover': {
      backgroundColor: Colors.white70,
      color: Colors.grey900,
    },
  },
  retryButton: {
    marginTop: 10,
    background: Colors.white,
    borderRadius: 18,
    color: Colors.grey900,
    textTransform: 'none',
    '&:hover': {
      backgroundColor: Colors.white70,
      color: Colors.grey900,
    },
  },
  modal: {
    position: 'absolute',
    padding: theme.spacing.unit * 2,
    width: theme.spacing.unit * 50,
    maxWidth: '90%',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, -50%)',
    outline: 'none',
  },
  divider: {
    marginBottom: 10,
  },
  videoContainer: {
    position: 'relative',
    margin: '0 auto',
    '& video': {
      display: 'block',
      width: '100%',
      maxWidth: '100%',
    },
  },
  videoContainerOverlay: {
    '&::before': {
      content: '\'\'',
      position: 'absolute',
      backgroundColor: 'rgba(0, 0, 0, 0.8)',
      top: -1,
      bottom: -1,
      right: -1,
      left: -1,
      zIndex: 3,
    },
  },
  videoOverlay: {
    position: 'absolute',
    zIndex: 4,
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    textAlign: 'center',
    '& p': { fontSize: '1rem' },
  },
  pairedDongleId: {
    fontWeight: 'bold',
  },
  pairStatus: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing.unit * 2,
  },
  pairStatusContent: {
    flex: 1,
    minWidth: 0,
  },
  canvas: {
    position: 'absolute',
    zIndex: 2,
    width: '100%',
    height: '100%',
  },
});

export const AddDeviceButton = connect()(withStyles(styles)(({
  classes, dispatch, buttonText, buttonStyle, buttonIcon,
}) => (
  <Button onClick={() => dispatch(openDialog('pair'))} className={classes.addButton} style={buttonStyle}>
    {buttonText}
    {buttonIcon && <AddCircleOutlineIcon style={{ color: 'rgba(255, 255, 255, 0.3)' }} />}
  </Button>
)));

class AddDevice extends Component {
  constructor(props) {
    super(props);

    this.state = {
      hasCamera: null,
      cameraError: null,
      pairLoading: Boolean(props.pairToken),
      pairError: null,
      pairDongleId: null,
      canvasWidth: null,
      canvasHeight: null,
    };

    this.videoRef = null;
    this.detector = null;
    this.stream = null;
    this.scanning = false;
    this.scanFrameId = null;
    this.mounted = false;
    this.cameraRequest = 0;
    this.checkingCamera = false;

    this.componentDidUpdate = this.componentDidUpdate.bind(this);
    this.onVideoRef = this.onVideoRef.bind(this);
    this.onCanvasRef = this.onCanvasRef.bind(this);
    this.modalClose = this.modalClose.bind(this);
    this.onQrRead = this.onQrRead.bind(this);
    this.restart = this.restart.bind(this);
    this.scanFrame = this.scanFrame.bind(this);
    this.startScanning = this.startScanning.bind(this);
    this.stopScanning = this.stopScanning.bind(this);
  }

  async componentDidMount() {
    this.mounted = true;
    const { pairToken, dispatch } = this.props;
    if (pairToken) {
      const result = await pairFromUrl(pairToken, dispatch);
      if (this.mounted) this.setState({ pairLoading: false, ...result });
    } else {
      this.componentDidUpdate();
    }
  }

  async componentDidUpdate() {
    if (!this.mounted || this.props.pairToken) return;

    const { pairLoading, pairError, pairDongleId } = this.state;
    let { hasCamera } = this.state;

    // Check for camera availability
    if (hasCamera === null) {
      if (this.checkingCamera) return;
      this.checkingCamera = true;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!this.mounted) return;
        hasCamera = devices.some((d) => d.kind === 'videoinput');
        this.setState({ hasCamera });
      } catch {
        if (!this.mounted) return;
        hasCamera = false;
        this.setState({ hasCamera });
      }
      this.checkingCamera = false;
    }

    // Initialize detector and camera stream
    if (this.videoRef && !this.detector && hasCamera && !pairDongleId) {
      this.cameraRequest += 1;
      const request = this.cameraRequest;
      try {
        this.detector = new BarcodeDetector({ formats: ['qr_code'] });
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        if (!this.mounted || request !== this.cameraRequest || !this.videoRef) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        this.stream = stream;
        this.videoRef.srcObject = stream;
        this.videoRef.setAttribute('playsinline', 'true');
        await this.videoRef.play();
        if (!this.mounted || request !== this.cameraRequest) return;
        this.startScanning();
      } catch (err) {
        if (!this.mounted || request !== this.cameraRequest) return;
        this.stopCamera();
        let cameraError = 'Unable to access camera.';
        if (err.name === 'NotAllowedError') {
          cameraError = 'Camera access denied. Please allow camera access in your browser settings and try again.';
        } else if (err.name === 'NotFoundError') {
          cameraError = 'No camera found on this device.';
        } else if (err.name === 'NotReadableError') {
          cameraError = 'Camera is in use by another application.';
        }
        this.setState({ hasCamera: false, cameraError });
      }
    }

    // Draw corner markers on canvas
    if (this.canvasRef && this.videoRef && this.videoRef.srcObject) {
      const { canvasWidth, canvasHeight } = this.state;
      const { width, height } = this.canvasRef.getBoundingClientRect();
      if (canvasWidth !== width || canvasHeight !== height) {
        this.setState({ canvasWidth: width, canvasHeight: height });
        const size = Math.min(width, height);
        const x = (width - size) / 2 + (size / 6);
        const y = (height - size) / 2 + (size / 6);
        const rect = size * (2 / 3);
        const stroke = size / 6;

        this.canvasRef.width = width;
        this.canvasRef.height = height;

        const ctx = this.canvasRef.getContext('2d');
        ctx.clearRect(0, 0, width, height);
        ctx.strokeStyle = 'white';

        ctx.beginPath();
        ctx.moveTo(x, y + stroke);
        ctx.lineTo(x, y);
        ctx.lineTo(x + stroke, y);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(x + rect - stroke, y);
        ctx.lineTo(x + rect, y);
        ctx.lineTo(x + rect, y + stroke);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(x + rect, y + rect - stroke);
        ctx.lineTo(x + rect, y + rect);
        ctx.lineTo(x + rect - stroke, y + rect);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(x + stroke, y + rect);
        ctx.lineTo(x, y + rect);
        ctx.lineTo(x, y + rect - stroke);
        ctx.stroke();
      }
    }

    // Start scanning if conditions are met
    if (!pairLoading && !pairError && !pairDongleId && this.stream && hasCamera && !this.scanning) {
      this.startScanning();
    }
  }

  async scanFrame() {
    if (!this.scanning || !this.videoRef || !this.detector) return;

    try {
      const results = await this.detector.detect(this.videoRef);
      if (!this.mounted || !this.scanning) return;
      if (results.length > 0) {
        this.onQrRead({ data: results[0].rawValue });
        return; // Stop scanning after detection
      }
    } catch (err) {
      // Ignore detection errors, just keep scanning
    }

    if (this.scanning) this.scanFrameId = requestAnimationFrame(this.scanFrame);
  }

  startScanning() {
    if (!this.mounted || !this.videoRef || !this.detector || this.scanning) return;
    this.scanning = true;
    this.scanFrame();
  }

  stopScanning() {
    this.scanning = false;
    if (this.scanFrameId) {
      cancelAnimationFrame(this.scanFrameId);
      this.scanFrameId = null;
    }
  }

  stopCamera() {
    this.cameraRequest += 1;
    this.stopScanning();
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    this.detector = null;
  }

  componentWillUnmount() {
    this.mounted = false;
    this.stopCamera();
  }

  async onVideoRef(ref) {
    this.videoRef = ref;
    this.componentDidUpdate();
  }

  async onCanvasRef(ref) {
    this.canvasRef = ref;
    this.componentDidUpdate();
  }

  restart() {
    this.setState({ pairLoading: false, pairError: null, pairDongleId: null }, () => {
      if (this.videoRef) this.videoRef.play();
      this.startScanning();
    });
  }

  modalClose() {
    const { pairDongleId } = this.state;

    this.stopCamera();
    this.props.onClose();

    if (pairDongleId) {
      this.props.dispatch(selectDevice(pairDongleId));
    }
  }

  async onQrRead({ data: result }) {
    const { pairDongleId, pairError, pairLoading } = this.state;
    if (!this.mounted || pairLoading || pairError || pairDongleId || !result) {
      return;
    }

    if (this.videoRef) this.videoRef.pause();
    this.stopScanning();
    Sentry.captureMessage('qr scanned', { extra: { result } });
    const fromUrl = result.startsWith('https://');
    let pairToken;
    if (fromUrl) {
      try {
        pairToken = new URL(result).searchParams.get('pair');
        if (!pairToken) {
          throw new Error('empty pairToken from url qr code');
        }
      } catch (err) {
        this.setState({ pairLoading: false, pairDongleId: null, pairError: 'Error: could not parse pair token from detected url' });
        console.error(err);
        return;
      }
    } else {
      try {
        // eslint-disable-next-line prefer-destructuring
        pairToken = result.split('--')[2];
        if (!pairToken) {
          throw new Error('empty pairToken from qr code');
        }
      } catch (err) {
        this.setState({ pairLoading: false, pairDongleId: null, pairError: 'Error: invalid QR code detected' });
        console.error(err);
        return;
      }
    }

    this.setState({ pairLoading: true, pairDongleId: null, pairError: null });
    const { devices, dispatch } = this.props;
    const method = devices.length === 0 ? 'add_device_new' : 'add_device_sidebar';
    const outcome = await performPairing(pairToken, fromUrl, method, dispatch);
    if (this.mounted) this.setState({ pairLoading: false, ...outcome });
  }

  render() {
    const { classes, pairToken } = this.props;
    const { hasCamera, cameraError, pairLoading, pairDongleId, pairError } = this.state;

    const videoContainerOverlay = (pairLoading || pairDongleId || pairError) ? classes.videoContainerOverlay : '';
    const pairStatus = (
      <>
        { pairLoading && <CircularProgress size={pairToken ? 32 : '10vw'} style={pairToken ? undefined : { color: '#525E66' }} aria-label="Pairing device" /> }
        { pairError && <Typography>{ pairError }</Typography> }
        { pairDongleId && (
          <Typography>
            {'Successfully paired device '}
            <span className={ classes.pairedDongleId }>{ pairDongleId }</span>
          </Typography>
        ) }
      </>
    );

    return (
      <Modal role="dialog" aria-labelledby="add-device-modal" open onClose={ this.modalClose }>
        <Paper className={ classes.modal }>
          <div className={ classes.titleContainer }>
            <Typography id="add-device-modal" variant="title">{pairToken ? 'Pairing device' : 'Pair device'}</Typography>
            {!pairToken && <Typography variant="caption">scan QR code</Typography>}
          </div>
          <hr className={ classes.divider } />
          { pairToken
            ? (
              <div className={ classes.pairStatus }>
                <div className={ classes.pairStatusContent }>{pairStatus}</div>
                <Button variant="contained" onClick={ this.modalClose }>Close</Button>
              </div>
            )
            : hasCamera === false
            ? (
              <>
                <Typography style={{ marginBottom: 5 }}>
                  { cameraError || 'Camera not found, please enable camera access.' }
                </Typography>
                <br />
                <Typography>
                  You can also scan the QR code using any other QR code
                  reader application.
                </Typography>
                <Button className={ classes.retryButton } onClick={ this.modalClose }>Close</Button>
              </>
            )
            : (
              <div className={ `${classes.videoContainer} ${videoContainerOverlay}` }>
                <canvas className={ classes.canvas } ref={ this.onCanvasRef } />
                <div className={ classes.videoOverlay }>
                  {pairStatus}
                  { pairError && (
                    <Button className={ classes.retryButton } onClick={ this.restart }>
                      try again
                    </Button>
                  ) }
                  { pairDongleId && (
                    <Button className={ classes.retryButton } onClick={ this.modalClose }>
                      close
                    </Button>
                  ) }
                </div>
                <video className={ classes.video } ref={ this.onVideoRef } />
              </div>
            )}
        </Paper>
      </Modal>
    );
  }
}

const stateToProps = (state) => ({
  profile: state.profile,
  devices: state.devices,
});

export default connect(stateToProps)(withStyles(styles)(AddDevice));
