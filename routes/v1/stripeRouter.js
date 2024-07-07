import express from 'express';
import Stripe from 'stripe';
import { appPrismaClient } from '#root/utils/prismaUtils.js';
import { getSecret } from '#root/utils/secretUtils.js';
import { sendSendGridEmail } from '#root/utils/emailUtils.js';

const stripeRouter = express.Router({ mergeParams: true });

const STRIPE_SECRET_KEY = await getSecret('STRIPE_SECRET_KEY');
const STRIPE_ENDPOINT_SECRET = await getSecret('STRIPE_ENDPOINT_SECRET');
const STRIPE_PRODUCT_ID = await getSecret('STRIPE_PRODUCT_ID');
const stripe = new Stripe(STRIPE_SECRET_KEY);

stripeRouter.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (request, response) => {
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
      case 'checkout.session.completed':
        const session = event.data.object;
        console.log('Checkout session completed:', session);

        const { customer, amount_total, metadata } = session;

        const user = await appPrismaClient.user.findFirst({
          where: {
            stripeCustomerId: customer,
          },
        });

        if (!user) {
          sendSendGridEmail({
            subject: 'Stripe payment error',
            force: true,
            body: `Stripe payment error: No user found for customer ${customer}`,
          });
          console.error('No user found for customer', customer);
          response.send();
          return;
        }

        console.log(
          'metadata:',
          JSON.stringify(metadata),
          'comparing to:',
          STRIPE_PRODUCT_ID,
        );

        if (metadata?.productId !== STRIPE_PRODUCT_ID) {
          console.log('Invalid product ID', metadata?.productId);
          return;
        }

        // Convert amount to dollars and determine seconds to add
        const amountInDollars = amount_total / 100; // Convert cents to dollars
        let secondsToAdd = 0;

        switch (amountInDollars) {
          case 5:
            secondsToAdd = 60 * 60;
            break;
          case 20:
            secondsToAdd = 600 * 60;
            break;
          case 100:
            secondsToAdd = 6000 * 60;
            break;
          default:
            console.error('Invalid payment amount', amountInDollars);
            response.send();
            return;
        }

        // Update user's time balance
        const updatedUser = await appPrismaClient.user.update({
          where: {
            id: user.id,
          },
          data: {
            timeBalance: user.timeBalance + secondsToAdd,
          },
        });

        console.log(
          `Updated user ${user.id} time balance to ${updatedUser.timeBalance} seconds`,
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
