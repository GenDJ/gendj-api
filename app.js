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
import { checkWarpEntities } from '#root/utils/warpUtils.js';

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

console.log('running startup pod cleanup1212');
checkWarpEntities().catch(error => {
  console.error('Error checking Warp entities1:', error);
});

// Schedule the task to run every 5 minutes
cron.schedule('*/5 * * * *', () => {
  console.log('running cron pod cleanup1212');
  checkWarpEntities().catch(error => {
    console.error('Error checking Warp entities2:', error);
  });
});

export default app;
