import { connect } from 'react-redux';
import { Button, CircularProgress, Modal, Paper, Typography } from '@material-ui/core';

import { closeDialog } from '../actions/navigation';
import AddDevice from './Dashboard/AddDevice';
import DeviceSettingsModal from './Dashboard/DeviceSettingsModal';
import UploadQueue from './Files/UploadQueue';
import TimeSelect from './TimeSelect';

const DIALOGS = new Set(['pair', 'settings', 'filter', 'uploads', 'downloads', 'route-info']);

const AppDialogs = ({ navigation, dongleId, device, devices, profile, dispatch }) => {
  const { dialog, dialogDevice, dialogParent } = navigation;
  const showSettings = dialog === 'settings' || dialogParent === 'settings';
  if (!DIALOGS.has(dialog) && !showSettings) return null;

  const onClose = () => dispatch(closeDialog());
  const targetId = dialogDevice || dongleId;
  const targetDevice = devices?.find((candidate) => candidate.dongle_id === targetId)
    || (device?.dongle_id === targetId ? device : null);
  const queueOnly = dialog === 'downloads' || dialog === 'route-info';
  const canManage = targetDevice?.is_owner || profile?.superuser;
  const settingsParent = dialog === 'uploads' && dialogParent === 'settings';

  // Route menus use the same queue owner as the uploads dialog.
  if (queueOnly && !canManage) return null;

  const loading = devices === null;
  const unavailable = dialog !== 'pair' && (!targetDevice || (showSettings && !canManage));
  if (loading || unavailable) {
    return (
      <Modal open onClose={onClose} className="flex items-center justify-center">
        <Paper className="p-4 outline-none">
          {loading ? <CircularProgress size={32} aria-label="Loading device" /> : <Typography>No access to this device.</Typography>}
          <Button onClick={onClose}>Close</Button>
        </Paper>
      </Modal>
    );
  }

  if (showSettings) {
    return (
      <>
        <DeviceSettingsModal key={targetId} isOpen={dialog === 'settings'} dialog={dialog} dongleId={targetId} onClose={onClose} />
        {settingsParent && <UploadQueue key={`uploads:${targetId}`} open update device={targetDevice} onClose={onClose} />}
      </>
    );
  }

  switch (dialog) {
    case 'pair':
      return <AddDevice key={navigation.pairToken ? `token:${navigation.pairToken}` : 'camera'} pairToken={navigation.pairToken} onClose={onClose} />;
    case 'filter':
      return <TimeSelect onClose={onClose} />;
    default:
      return <UploadQueue key={targetId} open={dialog === 'uploads'} update device={targetDevice} onClose={onClose} />;
  }
};

const stateToProps = (state) => ({
  navigation: state.navigation,
  dongleId: state.dongleId,
  device: state.device,
  devices: state.devices,
  profile: state.profile,
});

export default connect(stateToProps)(AppDialogs);
