import express from 'express';
import bodyParser from 'body-parser';
import { Webhook } from 'svix';
import { appPrismaClient } from '#root/utils/prismaUtils.js';
import { sendSendGridEmail } from '#root/utils/emailUtils.js';
import { getSecret } from '#root/utils/secretUtils.js';

const READY_WEBHOOK_SECRET_KEY = await getSecret('READY_WEBHOOK_SECRET_KEY');
const webhooksRouter = express.Router({ mergeParams: true });

// this is for clerk
webhooksRouter.post(
  '/',
  bodyParser.raw({ type: 'application/json' }),
  async function (req, res) {
    // Check if the 'Signing Secret' from the Clerk Dashboard was correctly provided
    const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
    if (!WEBHOOK_SECRET) {
      throw new Error('You need a WEBHOOK_SECRET in your .env');
    }

    // Grab the headers and body
    const headers = req.headers;
    const payload = req.body;
    console.log(
      'payload1212',
      payload,
      payload?.data,
      payload?.object,
      payload?.type,
    );

    // Get the Svix headers for verification
    const svix_id = headers['svix-id'];
    const svix_timestamp = headers['svix-timestamp'];
    const svix_signature = headers['svix-signature'];

    // If there are missing Svix headers, error out
    if (!svix_id || !svix_timestamp || !svix_signature) {
      return new Response('Error occured -- no svix headers', {
        status: 400,
      });
    }

    // Initiate Svix
    const wh = new Webhook(WEBHOOK_SECRET);

    let evt;

    // Attempt to verify the incoming webhook
    // If successful, the payload will be available from 'evt'
    // If the verification fails, error out and  return error code
    try {
      evt = wh.verify(JSON.stringify(payload), {
        'svix-id': svix_id,
        'svix-timestamp': svix_timestamp,
        'svix-signature': svix_signature,
      });
    } catch (err) {
      // Console log and return error
      console.log('Webhook failed to verify. Error:', err.message);
      return res.status(400).json({
        success: false,
        message: err.message,
      });
    }

    // Grab the ID and TYPE of the Webhook
    const { id } = evt.data;
    const eventType = evt.type;

    console.log(`Webhook with an ID of ${id} and type of ${eventType}`);
    // Console log the full payload to view
    console.log('Webhook body:', evt.data);

    try {
      if (eventType === 'user.created') {
        // sendSendGridEmail({
        //   subject: 'User Created',
        // });

        const created = await appPrismaClient.$transaction(async tx => {
          let dbUser = await tx.user.findUnique({
            where: {
              id,
            },
          });

          if (dbUser) {
            console.log('user already exists, update the meta');
            // Update the user record
            dbUser = await tx.user.update({
              where: {
                id,
              },
              data: {
                meta: { ...payload.data },
              },
            });
          } else {
            // Create a new user record
            dbUser = await tx.user.create({
              data: {
                id,
                meta: { ...payload.data },
              },
            });
          }
          return { user: dbUser };
        });
      } else if (eventType === 'user.deleted') {
        // sendSendGridEmail({
        //   subject: 'User deleted',
        // });
        const existingUser = await appPrismaClient.user.findUnique({
          where: {
            id,
          },
        });
        if (existingUser) {
          await appPrismaClient.user.update({
            where: {
              id,
            },
            // mark deletedAt as current datetime
            data: {
              deletedAt: new Date(),
            },
          });
        } else {
          // No user exists with the given id
          console.error(
            `User with id ${id} that was being deleted does not exist`,
          );
        }
      }
    } catch (err) {
      console.error('prismaErr1212', err);
    }

    return res.status(200).json({
      success: true,
      message: 'Webhook received',
    });
  },
);

// Middleware to check for secret key - Can likely be removed if no other webhooks use it
// const checkSecretKey = (req, res, next) => {
//   const secretKey = req.headers['x-secret-key'];
//   const expectedSecretKey = READY_WEBHOOK_SECRET_KEY; // Store this in your environment variables
//
//   if (!secretKey || secretKey !== expectedSecretKey) {
//     return res
//       .status(401)
//       .json({ message: 'Unauthorized: Invalid secret key' });
//   }
//   next();
// };

// REMOVED: Webhook for /podready is no longer needed for serverless.
// Runpod serverless status is typically checked via polling the /status endpoint
// or potentially via different webhooks if RunPod offers them for serverless jobs.

// webhooksRouter.post('/podready', checkSecretKey, async (req, res) => {
//   const { podId } = req.body;
//   console.log('podready1212', req.body);
//
//   try {
//     const updatedWarp = await appPrismaClient.warp.update({
//       where: {
//         podId, // This field no longer exists
//       },
//       data: {
//         podStatus: 'RUNNING', // This status is deprecated
//         podReadyAt: new Date(), // This field no longer exists
//       },
//     });
//
//     const startupTimeInSeconds =
//       (new Date().getTime() - updatedWarp.createdAt?.getTime()) / 1000;
//
//     console.log(`Pod ${podId} startup time: ${startupTimeInSeconds} seconds`);
//
//     res.json({
//       message: 'success',
//     });
//   } catch (err) {
//     console.error('Error updating warp or calculating startup time:', err);
//     res.status(500).json({
//       message: 'error',
//       error: err.message,
//     });
//   }
// });

export default webhooksRouter;
