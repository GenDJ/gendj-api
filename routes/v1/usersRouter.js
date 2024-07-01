import express from 'express';
import { ClerkExpressRequireAuth } from '@clerk/clerk-sdk-node';
import { appPrismaClient } from '#root/utils/prismaUtils.js';

const usersRouter = express.Router({ mergeParams: true });

usersRouter.get('/:userId', ClerkExpressRequireAuth(), async (req, res) => {
  const { userId } = req.params;

  const { userId: clerkId } = req.auth;
  console.log('usert1212', userId);

  if (!userId || !clerkId) {
    return res.status(400).send({ message: `Invalid request` });
  }

  if (userId !== clerkId) {
    return res.status(401).send({ message: `Unauthorized` });
  }

  const user = await appPrismaClient.user.findUnique({
    where: {
      id: userId,
    },
  });

  return res.json({
    message: 'success',
    entities: { users: [user] },
  });
});

export default usersRouter;
