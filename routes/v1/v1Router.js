import express from 'express';
const v1Router = express.Router();

import { ClerkExpressRequireAuth } from '@clerk/clerk-sdk-node';

import promptsRouter from '#root/routes/v1/promptsRouter.js';
import webhooksRouter from '#root/routes/v1/webhooksRouter.js';
import warpsRouter from '#root/routes/v1/warpsRouter.js';
import usersRouter from '#root/routes/v1/usersRouter.js';
import paymentsRouter from '#root/routes/v1/paymentsRouter.js';

v1Router.use('/promps', promptsRouter);
v1Router.use('/payments', paymentsRouter);
v1Router.use('/webhooks', webhooksRouter);
v1Router.use('/warps', warpsRouter);
v1Router.use('/users', usersRouter);

v1Router.get(
  '/closeddoorcheck',
  ClerkExpressRequireAuth({
    onError: (e1, e2) => {
      console.log('customerror1212', e1, e2);
    },
  }),
  (req, res) => {
    console.log('closeddoorcheck1212', req.auth);
    return res.json({
      message: 'closeddoorcheck',
      entities: { users: [{ id: req?.user?.id }] },
    });
  },
);

v1Router.get('/opendoorcheck', (req, res) => {
  console.log('opendoorcheck1212');
  return res.json({
    message: 'opendoorcheck',
    entities: { users: [{ id: req?.user?.id }] },
  });
});

export default v1Router;
