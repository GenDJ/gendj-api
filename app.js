import 'dotenv/config.js';
import express from 'express';
import cookieParser from 'cookie-parser';
import logger from 'morgan';
import cors from 'cors';
import bodyParser from 'body-parser';
import { CORS_ORIGIN } from '#root/utils/constants.js';
import stripeRouter from '#root/routes/v1/stripeRouter.js';
import v1Router from '#root/routes/v1/v1Router.js';
import cron from 'node-cron';
import { cleanupInactiveWarps } from '#root/utils/warpUtils.js';

var app = express();

app.use(logger('dev'));

app.use('/stripe', stripeRouter);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(bodyParser.json());

const corsOptions = {
  origin: CORS_ORIGIN,
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
  preflightContinue: true,
  credentials: true,
  optionsSuccessStatus: 200, // some legacy browsers (IE11, various SmartTVs) choke on 204
};

app.use(cors(corsOptions));

app.get('/alivecheck', function (req, res, next) {
  res.json({ message: 'root alivecheck' });
});

app.use('/v1', v1Router);

// Schedule the cleanup task to run every 5 minutes
cron.schedule('*/5 * * * *', () => {
  console.log('[Cron] Running cleanup for inactive/stuck warps...');
  cleanupInactiveWarps().catch(error => {
    // Log the error but don't crash the server
    console.error('[Cron] Error during cleanupInactiveWarps:', error);
  });
});

console.log('[Cron] Scheduled job cleanupInactiveWarps to run every 5 minutes.');

// Optional: Run cleanup once on startup as well?
// console.log('[Startup] Running initial cleanup for inactive/stuck warps...');
// cleanupInactiveWarps().catch(error => {
//   console.error('[Startup] Error during initial cleanupInactiveWarps:', error);
// });

export default app;
