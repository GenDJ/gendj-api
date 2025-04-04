import {
  cancelRunpodServerlessJob,
  getRunpodServerlessJobStatus,
} from '#root/utils/graphqlUtils.js';
import { appPrismaClient } from '#root/utils/prismaUtils.js';

// Function to check Warp entities - REMOVED as serverless handles this differently

/**
 * Calculates the estimated user time balance based on the warp's current state.
 * If the job hasn't started, returns the user's current balance.
 * If the job is running, deducts time from jobStartedAt to now.
 * If the job has ended, deducts the final duration.
 */
export async function calculateUserTimeBalanceAfterWarp({
  tx = null,
  userId,
  warpId,
  warp = null,
}) {
  const prisma = tx || appPrismaClient;

  // Fetch warp if not provided, selecting new serverless fields
  if (!warp) {
    warp = await prisma.warp.findUnique({
      where: { id: warpId },
      select: {
        id: true,
        jobStartedAt: true,
        jobEndedAt: true,
        // Optionally include jobStatus if needed for logic
      },
    });
  }

  if (!warp) {
    throw new Error(`Warp with ID ${warpId} not found`);
  }

  // Fetch user's current time balance
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      timeBalance: true,
    },
  });

  if (!user) {
    throw new Error(`User with ID ${userId} not found`);
  }

  // If job hasn't started billing, return current balance
  if (!warp.jobStartedAt) {
    return user.timeBalance;
  }

  let warpDurationSeconds = 0;
  const now = new Date();

  if (warp.jobEndedAt) {
    // Job has a definitive end time
    warpDurationSeconds = (warp.jobEndedAt.getTime() - warp.jobStartedAt.getTime()) / 1000;
  } else {
    // Job is currently running (or status pending), calculate duration up to now
    warpDurationSeconds = (now.getTime() - warp.jobStartedAt.getTime()) / 1000;
  }

  // Ensure duration isn't negative (e.g., clock skew issues)
  warpDurationSeconds = Math.max(0, warpDurationSeconds);

  const estimatedTimeBalance = user.timeBalance - warpDurationSeconds;

  return estimatedTimeBalance;
}

/**
 * Updates the user's time balance after a warp has definitively ended.
 * Requires the warp object passed in to have jobStartedAt and jobEndedAt set.
 */
export async function updateUserTimeBalanceForEndedWarp({
  tx, // Prisma transaction client
  userId,
  warp, // Warp object with jobStartedAt and jobEndedAt
}) {
  if (!warp || !warp.jobStartedAt || !warp.jobEndedAt) {
    throw new Error('Warp object with jobStartedAt and jobEndedAt is required to finalize balance.');
  }

  // Fetch the user's balance *before* this warp's cost is deducted
  const userBeforeUpdate = await tx.user.findUnique({
      where: { id: userId },
      select: { timeBalance: true },
  });

  if (!userBeforeUpdate) {
      throw new Error(`User with ID ${userId} not found during balance update.`);
  }

  const warpDuration = warp.jobEndedAt.getTime() - warp.jobStartedAt.getTime();
  const warpDurationSeconds = Math.max(0, warpDuration / 1000); // Ensure non-negative

  const finalTimeBalance = userBeforeUpdate.timeBalance - warpDurationSeconds;

  console.log(`Updating time balance for user ${userId}: Before=${userBeforeUpdate.timeBalance}, Duration=${warpDurationSeconds.toFixed(2)}s, After=${finalTimeBalance.toFixed(2)}`);

  const updatedUser = await tx.user.update({
    where: { id: userId },
    // Use Math.ceil or Math.floor depending on billing preference (charge full second?)
    data: { timeBalance: Math.ceil(finalTimeBalance) },
  });

  console.log(`User ${userId} balance updated to ${updatedUser.timeBalance}`);
  return updatedUser;
}

/**
 * Initiates the cancellation of a RunPod serverless job, marks the warp as CANCELLED,
 * and updates the user's time balance based on usage up to the cancellation request time.
 *
 * @param {Object} options
 * @param {string} options.userId
 * @param {string} options.warpId
 * @param {*=} [options.warp=null] Optional pre-fetched warp object
 */
export async function cancelWarpAndUpdateUserTimeBalance({
  userId,
  warpId,
  warp = null,
}) {
  if (!userId) {
    throw new Error('User ID is required');
  }

  // Fetch warp if not provided, ensuring we get the jobId
  if (!warp) {
    warp = await appPrismaClient.warp.findUnique({
      where: { id: warpId },
      select: {
        id: true,
        jobId: true,
        jobStatus: true,
        jobStartedAt: true, // Needed for balance calculation
      },
    });
  }

  if (!warp) {
    throw new Error(`Warp ${warpId} not found.`);
  }

  if (!warp.jobId) {
    console.warn(`Warp ${warpId} has no jobId, cannot cancel. Marking as FAILED.`);
    // Handle cases where job creation might have failed before jobId was stored
    const { warp: failedWarp, user } = await appPrismaClient.$transaction(async (tx) => {
       const failedWarp = await tx.warp.update({
         where: { id: warpId },
         data: { jobStatus: 'FAILED', jobEndedAt: new Date() }, // Mark as failed now
       });
       // No time deduction if job never had an ID (implies it never ran)
       const user = await tx.user.findUnique({ where: { id: userId }});
       return { warp: failedWarp, user };
    });
    return { warp: failedWarp, user };
  }

  // Check if warp is already in a terminal state
  const terminalStates = ['COMPLETED', 'FAILED', 'CANCELLED', 'ENDED']; // Include ENDED for legacy compat if needed
  if (terminalStates.includes(warp.jobStatus)) {
      console.log(`Warp ${warpId} (Job ${warp.jobId}) is already in terminal state: ${warp.jobStatus}. Skipping cancellation.`);
      // Fetch user for consistent return type
      const user = await appPrismaClient.user.findUnique({ where: { id: userId }});
      return { warp, user };
  }


  try {
    // Request cancellation from RunPod API
    await cancelRunpodServerlessJob(warp.jobId);
    console.log(`Cancellation request sent for Job ID: ${warp.jobId}`);
  } catch (error) {
    console.error(`Failed to send cancellation request for Job ${warp.jobId}:`, error);
    // Re-throw the error to prevent marking the job as CANCELLED in the DB
    // if the API call failed. Let the caller or the next cleanup run handle it.
    throw new Error(`Failed to cancel Runpod job ${warp.jobId}: ${error.message}`);
  }

  // Use a transaction to update warp status and user balance
  const { warp: cancelledWarp, user: updatedUser } =
    await appPrismaClient.$transaction(async (tx) => {
      // Mark the warp as cancelled and record the end time *now*
      // This is an approximation for billing purposes.
      const cancellationTime = new Date();
      const warpToUpdate = await tx.warp.findUnique({ where: { id: warpId } }); // Re-fetch inside tx

      // Ensure jobStartedAt exists before calculating duration
      const jobStartedAt = warpToUpdate.jobStartedAt;
      let warpData = {
        jobStatus: 'CANCELLED',
        jobEndedAt: cancellationTime
      };

      const cancelledWarp = await tx.warp.update({
        where: { id: warpId },
        data: warpData,
      });

      let updatedUser;
      // Only update balance if the job actually started
      if (jobStartedAt) {
        updatedUser = await updateUserTimeBalanceForEndedWarp({
          tx,
          userId,
          warp: { ...cancelledWarp, jobStartedAt: jobStartedAt, jobEndedAt: cancellationTime }, // Pass necessary fields
        });
      } else {
         // If job never started, just fetch the user to return
         updatedUser = await tx.user.findUnique({ where: { id: userId }});
         console.log(`Job ${warp.jobId} was cancelled before it started. No time deducted.`);
      }

      return { warp: cancelledWarp, user: updatedUser };
    });

  console.log(`Warp ${warpId} marked as CANCELLED, user ${userId} balance updated.`);
  return { warp: cancelledWarp, user: updatedUser };
}

// Added function to handle job status updates
/**
 * Fetches the latest status for a given warp's job from RunPod
 * and updates the warp record in the database.
 * @param {string} warpId
 * @returns {Promise<object|null>} Updated warp object or null if not found/no job ID
 */
export async function syncWarpJobStatus(warpId) {
  const warp = await appPrismaClient.warp.findUnique({
    where: { id: warpId },
    select: { id: true, jobId: true, jobStatus: true },
  });

  if (!warp || !warp.jobId) {
    console.log(`Warp ${warpId} not found or has no job ID. Skipping status sync.`);
    return null;
  }

  // Avoid syncing if already in a final state
  const terminalStates = ['COMPLETED', 'FAILED', 'CANCELLED'];
  if (terminalStates.includes(warp.jobStatus)) {
    // console.log(`Warp ${warpId} is already in terminal state ${warp.jobStatus}. Skipping status sync.`);
    return warp;
  }

  try {
    const jobStatusResult = await getRunpodServerlessJobStatus(warp.jobId);
    const { status, workerId, delayTime, executionTime } = jobStatusResult;

    const updateData = {
      jobStatus: status,
      workerId: workerId || warp.workerId, // Keep existing workerId if new status doesn't provide one
    };

    // Set jobStartedAt when status moves to IN_PROGRESS (if not already set)
    if (status === 'IN_PROGRESS' && !warp.jobStartedAt) {
       updateData.jobStartedAt = new Date(Date.now() - (delayTime || 0) * 1000); // Estimate start time based on delayTime
       console.log(`Setting jobStartedAt for Warp ${warpId} (Job ${warp.jobId}) based on IN_PROGRESS status.`);
    }

    // Set jobEndedAt when status moves to a terminal state (if not already set)
    if (terminalStates.includes(status) && !warp.jobEndedAt) {
       updateData.jobEndedAt = new Date(Date.now() - (delayTime || 0) * 1000 + (executionTime || 0) * 1000); // Estimate end time
       console.log(`Setting jobEndedAt for Warp ${warpId} (Job ${warp.jobId}) based on ${status} status.`);
    }


    const updatedWarp = await appPrismaClient.warp.update({
      where: { id: warpId },
      data: updateData,
    });

    // If the job just completed/failed, finalize the user's balance
    if (terminalStates.includes(status) && updatedWarp.jobEndedAt && updatedWarp.jobStartedAt) {
      console.log(`Job ${warp.jobId} reached terminal state ${status}. Finalizing time balance for user ${updatedWarp.createdById}.`);
      await appPrismaClient.$transaction(async (tx) => {
          await updateUserTimeBalanceForEndedWarp({
              tx,
              userId: updatedWarp.createdById,
              warp: updatedWarp, // Pass the fully updated warp object
          });
      });
    }


    // console.log(`Synced status for Warp ${warpId} (Job ${warp.jobId}): ${status}`);
    return updatedWarp;
  } catch (error) {
    console.error(`Error syncing status for Warp ${warpId} (Job ${warp.jobId}):`, error);
    // Optionally update warp status to UNKNOWN or ERROR_SYNCING
    return null;
  }
}

/**
 * Finds and cancels warps that appear inactive or stuck.
 * - Warps stuck in initial states (e.g., IN_QUEUE) for too long.
 * - Warps in IN_PROGRESS state whose updatedAt timestamp hasn't been updated recently.
 * This relies on some external mechanism updating the 'updatedAt' field for active warps.
 */
export async function cleanupInactiveWarps() {
  const stuckThresholdMinutes = 20; // Max time to wait for a job to start
  const inactivityThresholdMinutes = 15; // Max time since last update for an IN_PROGRESS job

  const now = new Date();
  const stuckTimeCutoff = new Date(now.getTime() - stuckThresholdMinutes * 60 * 1000);
  const inactivityCutoff = new Date(now.getTime() - inactivityThresholdMinutes * 60 * 1000);

  const potentiallyInactiveWarps = await appPrismaClient.warp.findMany({
    where: {
      OR: [
        // Case 1: Stuck in a non-running state for too long (e.g., IN_QUEUE, PENDING)
        {
          jobStatus: { in: ['IN_QUEUE', 'PENDING'] }, // Adjust based on actual initial statuses
          createdAt: { lt: stuckTimeCutoff }, // Created long ago but never progressed
          deletedAt: null,
        },
        // Case 2: Running but inactive (updatedAt is old)
        {
          jobStatus: 'IN_PROGRESS',
          updatedAt: { lt: inactivityCutoff }, // Not updated recently
          deletedAt: null,
        },
      ],
    },
    select: {
      id: true,
      createdById: true,
      jobId: true,
      jobStatus: true,
      jobStartedAt: true,
      updatedAt: true, // Include for logging/verification
    },
  });

  if (potentiallyInactiveWarps.length === 0) {
    console.log('[Cleanup] No stuck or inactive warps found.');
    return;
  }

  console.log(`[Cleanup] Found ${potentiallyInactiveWarps.length} potentially stuck/inactive warps. Attempting cancellation...`);

  let successCount = 0;
  let errorCount = 0;

  for (const warp of potentiallyInactiveWarps) {
    console.log(`[Cleanup] Processing warp ${warp.id} (Job: ${warp.jobId}, Status: ${warp.jobStatus}, Last Updated: ${warp.updatedAt.toISOString()}) for user ${warp.createdById}`);
    try {
      // Pass the fetched warp object to avoid redundant DB lookups
      await cancelWarpAndUpdateUserTimeBalance({ 
          userId: warp.createdById, 
          warpId: warp.id, 
          warp: warp 
      });
      console.log(`[Cleanup] Successfully initiated cancellation for warp ${warp.id}.`);
      successCount++;
    } catch (error) {
      console.error(`[Cleanup] Failed to cancel warp ${warp.id} (Job: ${warp.jobId}):`, error.message);
       if (!error.message.includes('already in terminal state')) {
           errorCount++;
      }
    }
  }

  console.log(`[Cleanup] Finished. Success: ${successCount}, Errors: ${errorCount}`);
}
