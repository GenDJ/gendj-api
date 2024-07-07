import { getSecret } from '#root/utils/secretUtils.js';

let CORS_ORIGIN = await getSecret('CORS_ORIGIN');

if (process.env.NODE_ENV === 'development') {
  console.log('isdev1212');
  CORS_ORIGIN = 'http://localhost:5173';
}

const API_BASE = `${CORS_ORIGIN}/v1/`;

const POD_STATUS = {
  CREATED: 'CREATED',
  RUNNING: 'RUNNING',
  RESTARTING: 'RESTARTING',
  EXITED: 'EXITED',
  PAUSED: 'PAUSED',
  DEAD: 'DEAD',
  TERMINATED: 'TERMINATED',
};

export { CORS_ORIGIN, API_BASE, POD_STATUS };
