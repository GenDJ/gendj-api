import { getSecret } from '#root/utils/secretUtils.js';

let CORS_ORIGIN = await getSecret('CORS_ORIGIN');

if (process.env.NODE_ENV === 'development') {
  console.log('isdev1212');
  CORS_ORIGIN = 'http://localhost:5173';
}

const API_BASE = `${CORS_ORIGIN}/v1/`;

export {
  CORS_ORIGIN,
  API_BASE,
};
