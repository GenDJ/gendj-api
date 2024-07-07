import express from 'express';
import { ClerkExpressRequireAuth } from '@clerk/clerk-sdk-node';
import { appPrismaClient } from '#root/utils/prismaUtils.js';
import {
  planAndCreateRunpodPod,
  endRunpodPod,
} from '#root/utils/graphqlUtils.js';
import {
  endWarpAndUpdateUserTimeBalance,
  calculateUserTimeBalanceAfterWarp,
} from '#root/utils/warpUtils.js';

const warpsRouter = express.Router({ mergeParams: true });

// create a new warp
warpsRouter.post('/', ClerkExpressRequireAuth(), async (req, res) => {
  const { userId } = req.auth;

  try {
    // Check if the user already has a warp with podStatus "RUNNING" or "PENDING"
    const existingWarp = await appPrismaClient.warp.findFirst({
      where: {
        createdBy: { id: userId },
        podStatus: { in: ['RUNNING', 'PENDING'] },
      },
    });

    if (existingWarp) {
      // If a running or pending warp exists, return it
      const estimatedUserTimeBalance = await calculateUserTimeBalanceAfterWarp({
        userId,
        warpId: existingWarp?.id,
      });
      return res.json({
        success: true,
        estimatedUserTimeBalance,
        entities: { warps: [existingWarp] },
      });
    } else {
      // If no running or pending warp exists, create a new one

      // Create a new pod with the selected GPU and volume
      const podMeta = await planAndCreateRunpodPod();

      const warp = await appPrismaClient.warp.create({
        data: {
          createdBy: { connect: { id: userId } },
          podMeta,
          podId: podMeta?.id,
          podStatus: 'PENDING', // Set initial podStatus to "PENDING"
        },
      });

      return res.json({ success: true, entities: { warps: [warp] } });
    }
  } catch (error) {
    console.error('Error creating or retrieving warp:', error);
    return res.status(500).json({ error: error.message });
  }
});

// get all warps for the current user
warpsRouter.get('/', ClerkExpressRequireAuth(), async (req, res) => {
  const { userId } = req.auth;

  try {
    const warps = await appPrismaClient.warp.findMany({
      where: {
        createdBy: { id: userId },
        deletedAt: null,
      },
      orderBy: {
        createdAt: 'desc', // or 'asc' if you prefer
      },
    });

    return res.json({ sucess: true, entities: { warps } });
  } catch (error) {
    console.error('Error fetching warps:', error);
    return res.status(500).json({ error: error.message });
  }
});

// get all warps for the current user
warpsRouter.get('/:warpId', ClerkExpressRequireAuth(), async (req, res) => {
  const { userId } = req.auth;
  const { warpId } = req.params;

  if (!warpId) {
    return res.status(400).json({ error: 'Warp ID is required' });
  }

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    const warp = await appPrismaClient.warp.findFirst({
      where: {
        id: warpId,
        createdBy: { id: userId },
      },
    });

    return res.json({ sucess: true, entities: { warps: [warp] } });
  } catch (error) {
    console.error('Error fetching warp:', error);
    return res.status(500).json({ error: error.message });
  }
});

warpsRouter.post(
  '/:warpId/heartbeat',
  ClerkExpressRequireAuth(),
  async (req, res) => {
    const { userId } = req.auth;
    const { warpId } = req.params;

    try {
      const warp = await appPrismaClient.warp.findFirst({
        where: {
          id: warpId,
          createdBy: { id: userId },
        },
      });

      if (!warp) {
        return res.status(404).json({ error: 'Warp not found' });
      }

      const estimatedUserTimeBalance = await calculateUserTimeBalanceAfterWarp({
        userId,
        warpId,
      });

      let updatedWarp = warp;

      if (estimatedUserTimeBalance < 0) {
        await endWarpAndUpdateUserTimeBalance({ warpId, userId, warp });
        return res.status(400).json({
          error: 'Insufficient balance to continue Warp',
        });
      } else {
        updatedWarp = await appPrismaClient.warp.update({
          where: { id: warpId },
          data: {
            updatedAt: new Date(),
          },
        });

        return res.json({
          sucess: true,
          estimatedUserTimeBalance,
          warps: [updatedWarp],
        });
      }
    } catch (error) {
      console.error('Error updating warp heartbeat:', error);
      return res.status(500).json({ error: error.message });
    }
  },
);

warpsRouter.post(
  '/:warpId/end',
  ClerkExpressRequireAuth(),
  async (req, res) => {
    const { warpId } = req.params;
    const userId = req.auth.userId;

    try {
      // Fetch the Warp
      const warp = await appPrismaClient.warp.findUnique({
        where: { id: warpId },
        select: { id: true, podId: true, createdById: true, podStatus: true },
      });

      // Check if the Warp exists and belongs to the user
      if (!warp) {
        return res.status(404).json({ error: 'Warp not found' });
      }
      if (warp.createdById !== userId) {
        return res
          .status(403)
          .json({ error: 'Not authorized to end this Warp' });
      }

      // Check if the Warp is already ended
      if (warp.podStatus === 'ended') {
        return res.status(400).json({ error: 'Warp is already ended' });
      }

      // Attempt to end the RunPod
      try {
        const { warp: endedWarp, user: updatedUser } =
          await endWarpAndUpdateUserTimeBalance({ warpId, userId, warp });
        res
          .status(200)
          .json({ entities: { warps: [endedWarp], users: [updatedUser] } });
      } catch (endError) {
        console.error(
          `Failed to end pod for Warp in router ${warpId}:`,
          endError,
        );
        res.status(500).json({ error: 'Failed to end Warp' });
      }
    } catch (error) {
      console.error('Error in Warp end endpoint:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default warpsRouter;
