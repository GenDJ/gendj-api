import express from 'express';
import { ClerkExpressRequireAuth } from '@clerk/clerk-sdk-node';
import { appPrismaClient } from '#root/utils/prismaUtils.js';
import {
  startRunpodServerlessJob,
} from '#root/utils/graphqlUtils.js';
import {
  cancelWarpAndUpdateUserTimeBalance,
  calculateUserTimeBalanceAfterWarp,
  syncWarpJobStatus,
} from '#root/utils/warpUtils.js';

const warpsRouter = express.Router({ mergeParams: true });

// create a new warp (start a serverless job)
warpsRouter.post('/', ClerkExpressRequireAuth(), async (req, res) => {
  const { userId } = req.auth;
  const activeJobStatuses = ['IN_QUEUE', 'IN_PROGRESS', 'PAUSED']; // Define active serverless statuses

  try {
    // Check if the user already has an active serverless job warp
    const existingWarp = await appPrismaClient.warp.findFirst({
      where: {
        createdById: userId,
        jobStatus: { in: activeJobStatuses },
        deletedAt: null, // Ensure it's not a soft-deleted record
      },
    });

    if (existingWarp) {
      // If an active warp exists, sync its status and return it
      console.log(`User ${userId} already has active warp ${existingWarp.id}. Syncing status...`);
      const syncedWarp = await syncWarpJobStatus(existingWarp.id);
      const estimatedUserTimeBalance = await calculateUserTimeBalanceAfterWarp({
        userId,
        warpId: syncedWarp?.id || existingWarp.id,
        warp: syncedWarp || existingWarp, // Pass the potentially updated warp
      });

      return res.json({
        success: true,
        estimatedUserTimeBalance,
        entities: { warps: [syncedWarp || existingWarp] }, // Return the most up-to-date warp
      });
    } else {
      // If no active warp exists, start a new serverless job
      console.log(`No active warp found for user ${userId}. Starting new serverless job...`);
      const jobDetails = await startRunpodServerlessJob(); // Calls the refactored RunPod v2 API function

      if (!jobDetails || !jobDetails.id) {
        throw new Error('Failed to start serverless job or job ID not returned.');
      }

      const warp = await appPrismaClient.warp.create({
        data: {
          createdBy: { connect: { id: userId } },
          jobId: jobDetails.id,
          jobStatus: jobDetails.status || 'IN_QUEUE', // Initial status from RunPod
          jobRequestedAt: new Date(), // Record when the request was made
          // jobStartedAt, jobEndedAt, workerId will be updated later via sync or webhooks
        },
      });

      // No estimated balance needed here as job hasn't started billing
      return res.json({ success: true, entities: { warps: [warp] } });
    }
  } catch (error) {
    console.error('Error creating or retrieving serverless warp:', error);
    // Check for specific RunPod errors if possible
    return res.status(500).json({ error: error.message || 'Failed to process warp request' });
  }
});

// get all warps for the current user
warpsRouter.get('/', ClerkExpressRequireAuth(), async (req, res) => {
  const { userId } = req.auth;

  try {
    const warps = await appPrismaClient.warp.findMany({
      where: {
        createdById: userId,
        deletedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Optional: Could sync status for non-terminal warps here, but might be slow.
    // For now, just return the stored data.

    return res.json({ success: true, entities: { warps } }); // Corrected 'sucess' to 'success'
  } catch (error) {
    console.error('Error fetching warps:', error);
    return res.status(500).json({ error: error.message });
  }
});

// get a specific warp for the current user, syncing its status first
warpsRouter.get('/:warpId', ClerkExpressRequireAuth(), async (req, res) => {
  const { userId } = req.auth;
  const { warpId } = req.params;

  if (!warpId) {
    return res.status(400).json({ error: 'Warp ID is required' });
  }

  try {
    // First, verify the warp exists and belongs to the user
    let warp = await appPrismaClient.warp.findFirst({
      where: {
        id: warpId,
        createdById: userId,
        deletedAt: null,
      },
    });

    if (!warp) {
      return res.status(404).json({ error: 'Warp not found or access denied' });
    }

    // Sync the job status with RunPod before returning
    const updatedWarp = await syncWarpJobStatus(warpId);

    // Return the updated warp data, or the original if sync failed
    const returnWarp = updatedWarp || warp;

    return res.json({ success: true, entities: { warps: [returnWarp] } }); // Corrected 'sucess' to 'success'
  } catch (error) {
    console.error(`Error fetching or syncing warp ${warpId}:`, error);
    return res.status(500).json({ error: error.message });
  }
});

// Re-implemented Heartbeat endpoint for active warps
warpsRouter.post(
  '/:warpId/heartbeat',
  ClerkExpressRequireAuth(),
  async (req, res) => {
    const { userId } = req.auth;
    const { warpId } = req.params;

    if (!warpId) {
      return res.status(400).json({ error: 'Warp ID is required' });
    }

    try {
      // Fetch the warp, ensuring it belongs to the user
      let warp = await appPrismaClient.warp.findFirst({
        where: {
          id: warpId,
          createdById: userId,
        },
        // Select fields needed for logic and response
        select: { 
            id: true, 
            createdById: true, 
            jobStatus: true, 
            jobStartedAt: true, 
            jobEndedAt: true 
        }
      });

      if (!warp) {
        return res.status(404).json({ error: 'Warp not found or access denied' });
      }

      // Only allow heartbeats for jobs actively in progress
      if (warp.jobStatus !== 'IN_PROGRESS') {
        return res.status(400).json({ error: `Warp is not IN_PROGRESS (status: ${warp.jobStatus}). Cannot heartbeat.` });
      }

      // Calculate estimated balance
      const estimatedUserTimeBalance = await calculateUserTimeBalanceAfterWarp({
        userId,
        warpId,
        warp, // Pass the fetched warp
      });

      let updatedWarp = warp;

      // If balance is insufficient, end the warp
      if (estimatedUserTimeBalance <= 0) {
        console.log(`[Heartbeat] User ${userId} has insufficient balance for warp ${warpId}. Triggering cancellation.`);
        const { warp: cancelledWarp, user: updatedUser } = await cancelWarpAndUpdateUserTimeBalance({ warpId, userId, warp });
        return res.status(402).json({ // 402 Payment Required seems appropriate
          error: 'Insufficient balance to continue Warp',
          estimatedUserTimeBalance: 0, // Reflect that balance is depleted
          entities: { warps: [cancelledWarp], users: [updatedUser] },
        });
      } else {
        // If balance is sufficient, just update the timestamp
        updatedWarp = await appPrismaClient.warp.update({
          where: { id: warpId },
          data: {
            updatedAt: new Date(),
          },
        });

        return res.json({
          success: true,
          estimatedUserTimeBalance, // Return the latest estimate
          entities: { warps: [updatedWarp] },
        });
      }
    } catch (error) {
      console.error(`Error updating warp heartbeat for ${warpId}:`, error);
      // Handle specific errors like cancellation failure if needed
      if (error.message.includes('RunPod API') || error.message.includes('already in terminal state')) {
          // Error occurred during cancellation attempt due to low balance
          return res.status(500).json({ error: 'Failed to end warp due to low balance', details: error.message });
      }
      return res.status(500).json({ error: 'Internal server error during heartbeat' });
    }
  },
);

// End (cancel) a specific warp (serverless job)
warpsRouter.post(
  '/:warpId/end',
  ClerkExpressRequireAuth(),
  async (req, res) => {
    const { warpId } = req.params;
    const userId = req.auth.userId;

    try {
      // Fetch the Warp first to ensure it exists and belongs to the user
      const warp = await appPrismaClient.warp.findUnique({
        where: { id: warpId },
        select: { id: true, createdById: true, jobId: true, jobStatus: true, jobStartedAt: true }, // Select necessary fields
      });

      // Check if the Warp exists
      if (!warp) {
        return res.status(404).json({ error: 'Warp not found' });
      }
      // Check if the user is authorized
      if (warp.createdById !== userId) {
        return res
          .status(403)
          .json({ error: 'Not authorized to end this Warp' });
      }

      // Use the refactored function to cancel the job and update balance
      const { warp: cancelledWarp, user: updatedUser } =
        await cancelWarpAndUpdateUserTimeBalance({ warpId, userId, warp });

      // Respond with the updated warp and user data
      res
        .status(200)
        .json({ success: true, entities: { warps: [cancelledWarp], users: [updatedUser] } });

    } catch (error) {
      console.error(`Error in Warp end endpoint for ${warpId}:`, error);
      // Provide a more specific error if the cancellation itself failed vs. other errors
      if (error.message.includes('RunPod API')) {
         return res.status(502).json({ error: 'Failed to communicate with RunPod to cancel job', details: error.message });
      } else if (error.message.includes('already in terminal state')) {
          return res.status(400).json({ error: error.message }); // Bad request - already ended
      }
      res.status(500).json({ error: 'Internal server error during warp cancellation' });
    }
  },
);

export default warpsRouter;
