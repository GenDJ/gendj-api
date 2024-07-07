import express from 'express';
import { ClerkExpressRequireAuth } from '@clerk/clerk-sdk-node';
import { appPrismaClient } from '#root/utils/prismaUtils.js';
import Stripe from 'stripe';
import { getSecret } from '#root/utils/secretUtils.js';
import { clerkClient } from '#root/utils/authUtils.js';
import { isEmail } from '#root/utils/dataUtils.js';
import { CORS_ORIGIN } from '#root/utils/constants.js';

const STRIPE_SECRET_KEY = await getSecret('STRIPE_SECRET_KEY');

const stripe = new Stripe(STRIPE_SECRET_KEY); // Step 2: Initialize Stripe

const paymentsRouter = express.Router({ mergeParams: true });

paymentsRouter.post(
  '/create-checkout-session',
  ClerkExpressRequireAuth(),
  async (req, res) => {
    const { amount, quantity } = req.body;
    const { userId: clerkId } = req.auth;
    console.log('paymentb1212', amount, quantity);
    const clerkUser = await clerkClient.users.getUser(clerkId);
    if (!clerkUser) {
      return res.status(400).send({ message: `user not found` });
    }
    const potentialEmail = clerkUser.emailAddresses?.[0]?.emailAddress;

    let customerEmail = '';
    if (potentialEmail && isEmail(potentialEmail)) {
      customerEmail = potentialEmail;
    }

    try {
      const user = await appPrismaClient.user.findUnique({
        where: {
          id: clerkId,
        },
      });

      let customer;
      let customerId = user?.stripeCustomerId;
      if (!customerId) {
        customer = await stripe.customers.create({
          email: customerEmail, // Replace with the customer's email address
          // You can add more details here if necessary (e.g., name, address)
        });

        await appPrismaClient.user.update({
          where: {
            id: clerkId,
          },
          data: {
            stripeCustomerId: customer.id,
          },
        });

        customerId = customer.id;
      }

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: `${quantity} Hour${quantity > 1 ? 's' : ''}`,
                description: `Purchase ${quantity} hour${
                  quantity > 1 ? 's' : ''
                } of time`,
              },
              unit_amount: amount,
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url: `${CORS_ORIGIN}/billing?status=success&amount=${amount}`,
        cancel_url: `${CORS_ORIGIN}/billing?status=cancelled`,
        customer: customerId,
      });

      console.log('session1212', session);

      return res.json({
        success: true,
        url: session.url,
      });
    } catch (err) {
      console.error('paymenterr1313', err);
      return res.status(500).send({ message: `Payment Error` });
    }
  },
);

export default paymentsRouter;
