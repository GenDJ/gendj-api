import express from 'express';
import Stripe from 'stripe';
import { appPrismaClient } from '#root/utils/prismaUtils.js';
import { getSecret } from '#root/utils/secretUtils.js';
import { sendSendGridEmail } from '#root/utils/emailUtils.js';

const stripeRouter = express.Router({ mergeParams: true });

const STRIPE_SECRET_KEY = await getSecret('STRIPE_SECRET_KEY');
const STRIPE_ENDPOINT_SECRET = await getSecret('STRIPE_ENDPOINT_SECRET');
const stripe = new Stripe(STRIPE_SECRET_KEY);

// Define the time packs and their corresponding hours
const TIME_PACKS = {
  pack_1hour: 60,
  pack_10hours: 600,
  pack_100hours: 6000,
};

stripeRouter.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (request, response) => {
    throw new Error('unimplemented');
    const sig = request.headers['stripe-signature'];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        request.body,
        sig,
        STRIPE_ENDPOINT_SECRET,
      );
    } catch (err) {
      console.log('stripe webhook error1313', err);
      response.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    // Handle the event
    switch (event.type) {
      case 'payment_intent.succeeded':
        const paymentIntentSucceeded = event.data.object;
        console.log('paymentIntentSucceeded1212', paymentIntentSucceeded);
        const { customer, metadata } = paymentIntentSucceeded;

        const user = await appPrismaClient.user.findFirst({
          where: {
            stripeCustomerId: customer,
          },
        });

        if (!user) {
          sendSendGridEmail({
            subject: 'Stripe payment error',
            force: true,
            body: `stripe payment error: No user found for customer ${customer}`,
          });
          console.error('No user found for customer', customer);
          response.send();
          return;
        }

        // Get the time pack from metadata
        const timePack = metadata.time_pack;
        if (!TIME_PACKS[timePack]) {
          console.error('Invalid time pack', timePack);
          response.send();
          return;
        }

        const minutesToAdd = TIME_PACKS[timePack];

        // Update user's time balance
        const updatedUser = await appPrismaClient.user.update({
          where: {
            id: user.id,
          },
          data: {
            timeBalance: user.timeBalance + minutesToAdd,
          },
        });

        console.log(
          `Updated user ${user.id} time balance to ${updatedUser.timeBalance} hours`,
        );
        break;
      // ... handle other event types
      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    // Return a 200 response to acknowledge receipt of the event
    response.send();
  },
);

export default stripeRouter;
