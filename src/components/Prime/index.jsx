import { connect } from 'react-redux';

import { Button, Modal, Paper, Typography } from '@material-ui/core';
import { closeDialog } from '../../actions/navigation';
import PrimeManage from './PrimeManage';
import PrimeCheckout from './PrimeCheckout';

const Prime = (props) => {
  const params = new URLSearchParams(props.search);
  const stripeCancelled = params.get('stripe_cancelled');
  const stripeSuccess = params.get('stripe_success');

  const { device, profile, subscription, dialog, dispatch } = props;
  if (!profile || !device) {
    return null;
  }

  if (!device.is_owner && !profile.superuser) {
    return (<Typography>No access</Typography>);
  }
  const manage = device.prime || stripeSuccess;
  const unavailable = ['cancel-prime', 'change-plan'].includes(dialog) && (!manage || !subscription?.user_id);
  return (
    <>
      {manage
        ? <PrimeManage key={device.dongle_id} stripeSuccess={stripeSuccess} />
        : <PrimeCheckout key={device.dongle_id} stripeCancelled={stripeCancelled} />}
      {unavailable && (
        <Modal open onClose={() => dispatch(closeDialog())} className="flex items-center justify-center">
          <Paper role="dialog" aria-modal="true" aria-labelledby="prime-unavailable-title" className="w-[400px] max-w-[90%] p-4 outline-none">
            <Typography id="prime-unavailable-title" variant="title">
              {dialog === 'cancel-prime' ? 'Cancel prime subscription' : 'Change prime plan'}
            </Typography>
            <Typography className="my-4">
              {manage
                ? 'Subscription details are not available yet. Please try again later.'
                : 'This device does not have a prime subscription to manage.'}
            </Typography>
            <div className="flex justify-end">
              <Button variant="contained" onClick={() => dispatch(closeDialog())}>Close</Button>
            </div>
          </Paper>
        </Modal>
      )}
    </>
  );
};

const stateToProps = (state) => ({
  subscription: state.subscription,
  device: state.device,
  profile: state.profile,
  search: state.router.location.search,
  dialog: state.navigation.dialog,
});

export default connect(stateToProps)(Prime);
