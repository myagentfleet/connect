import { connect } from 'react-redux';

import { Typography } from '@material-ui/core';
import PrimeManage from './PrimeManage';
import PrimeCheckout from './PrimeCheckout';

const Prime = (props) => {
  const params = new URLSearchParams(props.search);
  const stripeCancelled = params.get('stripe_cancelled');
  const stripeSuccess = params.get('stripe_success');

  const { device, profile } = props;
  if (!profile || !device) {
    return null;
  }

  if (!device.is_owner && !profile.superuser) {
    return (<Typography>No access</Typography>);
  }
  if (device.prime || stripeSuccess) {
    return (<PrimeManage key={device.dongle_id} stripeSuccess={ stripeSuccess } />);
  }
  return (<PrimeCheckout key={device.dongle_id} stripeCancelled={ stripeCancelled } />);
};

const stateToProps = (state) => ({
  subscription: state.subscription,
  device: state.device,
  profile: state.profile,
  search: state.router.location.search,
});

export default connect(stateToProps)(Prime);
