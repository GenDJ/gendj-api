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
       console.log(`[CancelWarp] Warp ${warpId} (Job ${warp.jobId}) is already in terminal state: ${warp.jobStatus}. Skipping cancellation.`);
      // Fetch user for consistent return type
      const user = await appPrismaClient.user.findUnique({ where: { id: userId }});
      return { warp, user };
  }

  console.log(`[CancelWarp] Attempting to cancel warp ${warpId} (Job ${warp.jobId}) for user ${userId}.`);

  try {
    // Request cancellation from RunPod API
    console.log(`[CancelWarp] Sending cancellation request to RunPod API for Job ID: ${warp.jobId}...`);
    await cancelRunpodServerlessJob(warp.jobId);
    console.log(`[CancelWarp] Successfully sent cancellation request to RunPod for Job ID: ${warp.jobId}.`);
  } catch (error) {
    console.error(`[CancelWarp] Failed to send cancellation request via RunPod API for Job ${warp.jobId}:`, error);
    // Re-throw the error to prevent marking the job as CANCELLED in the DB
    // if the API call failed. Let the caller or the next cleanup run handle it.
    throw new Error(`[CancelWarp] Failed to cancel Runpod job ${warp.jobId} via API: ${error.message}`);
  }

  console.log(`[CancelWarp] RunPod API cancellation request successful for job ${warp.jobId}. Proceeding with DB update transaction.`);
  // Use a transaction to update warp status and user balance
  const { warp: cancelledWarp, user: updatedUser } =
    await appPrismaClient.$transaction(async (tx) => {
       console.log(`[CancelWarp TX] Starting transaction for warp ${warpId}...`);
      // Mark the warp as cancelled and record the end time *now*
      // This is an approximation for billing purposes.
      const cancellationTime = new Date();
      // Re-fetch inside tx to get latest state before update
      const warpToUpdate = await tx.warp.findUnique({ where: { id: warpId }, select: { jobStartedAt: true } });

      // Ensure jobStartedAt exists before calculating duration
      const jobStartedAt = warpToUpdate.jobStartedAt;
      let warpData = {
        jobStatus: 'CANCELLED',
        jobEndedAt: cancellationTime
      };

       console.log(`[CancelWarp TX] Updating warp ${warpId} status to CANCELLED and setting jobEndedAt.`);
      const cancelledWarp = await tx.warp.update({
        where: { id: warpId },
        data: warpData,
      });

      let updatedUser;
      // Only update balance if the job actually started
      if (jobStartedAt) {
         console.log(`[CancelWarp TX] Job ${warp.jobId} had started. Calculating and updating user ${userId} balance...`);
        updatedUser = await updateUserTimeBalanceForEndedWarp({
          tx,
          userId,
          warp: { ...cancelledWarp, jobStartedAt: jobStartedAt, jobEndedAt: cancellationTime }, // Pass necessary fields
        });
         console.log(`[CancelWarp TX] User ${userId} balance updated.`);
      } else {
         // If job never started, just fetch the user to return
         console.log(`[CancelWarp TX] Job ${warp.jobId} was cancelled before it started. Fetching user ${userId} without balance update.`);
         updatedUser = await tx.user.findUnique({ where: { id: userId }});
         console.log(`[CancelWarp TX] Job ${warp.jobId} was cancelled before it started. No time deducted.`);
      }

       console.log(`[CancelWarp TX] Transaction complete for warp ${warpId}.`);
      return { warp: cancelledWarp, user: updatedUser };
    });

   console.log(`[CancelWarp] Successfully marked warp ${warpId} as CANCELLED and updated user ${userId} balance (if applicable).`);
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
 * Finds and cancels warps that appear inactive, stuck, or have run too long.
 * 1. Fetches all non-terminal warps.
 * 2. Syncs their status with RunPod.
 * 3. Cancels warps based on updated status and time thresholds:
 *    - Stuck in initial states (IN_QUEUE, PENDING) for too long.
 *    - Running (IN_PROGRESS) for longer than a maximum allowed duration.
 */
export async function cleanupInactiveWarps() {
  const stuckThresholdMinutes = 20; // Max time to wait for a job to start
  // const maxRuntimeMinutes = 60; // Max total runtime for any IN_PROGRESS job before cleanup cancels it - REMOVED
  const inactivityThresholdMinutes = 15; // Max time since last update (heartbeat) for an IN_PROGRESS job
  const recheckTerminalMinutes = 30; // Check terminal (CANCELLED/FAILED) warps older than this, in case Runpod didn't stop them

  const now = new Date();
  const stuckTimeCutoff = new Date(now.getTime() - stuckThresholdMinutes * 60 * 1000);
  // const maxRuntimeCutoff = new Date(now.getTime() - maxRuntimeMinutes * 60 * 1000); - REMOVED
  const inactivityCutoff = new Date(now.getTime() - inactivityThresholdMinutes * 60 * 1000);
  const recheckTerminalCutoff = new Date(now.getTime() - recheckTerminalMinutes * 60 * 1000);

  // Define states we expect to be final vs potentially active
  const trulyTerminalStates = ['COMPLETED', 'ENDED']; // States we generally trust once set
  const activeStates = ['IN_QUEUE', 'PENDING', 'IN_PROGRESS', 'PAUSED']; // States that should eventually become terminal
  const potentiallyStuckTerminalStates = ['CANCELLED', 'FAILED']; // States we *requested* but might need re-checking

  console.log('[Cleanup] Starting inactive/stuck/discrepancy warp check...');

  // Fetch warps that are potentially active OR could be stuck terminal jobs
  const warpsToCheck = await appPrismaClient.warp.findMany({
    where: {
      deletedAt: null,
      jobId: { not: null }, // Only check warps that have a job ID
      OR: [
        { jobStatus: { in: activeStates } }, // Actively supposed to be running/queued
        { jobStatus: null }, // Might have failed before status set
        {
          jobStatus: { in: potentiallyStuckTerminalStates },
          updatedAt: { lt: recheckTerminalCutoff }, // Check CANCELLED/FAILED jobs that haven't been updated recently
        },
      ],
    },
    select: {
      id: true,
      createdById: true,
      jobId: true,
      jobStatus: true, // The status currently in our DB
      jobStartedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (warpsToCheck.length === 0) {
    console.log('[Cleanup] No warps found needing status check.');
    return;
  }

  console.log(`[Cleanup] Found ${warpsToCheck.length} warps to check. Syncing status and evaluating...`);

  let cancelAttemptCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  for (const initialWarp of warpsToCheck) {
    let needsCancellation = false;
    let reason = '';
    const initialDbStatus = initialWarp.jobStatus; // Store the DB status before sync

    try {
      console.log(`[Cleanup] Syncing status for warp ${initialWarp.id} (Job: ${initialWarp.jobId}, DB Status: ${initialDbStatus || 'NULL'})`);
      const syncedWarp = await syncWarpJobStatus(initialWarp.id);

      if (!syncedWarp) {
        console.warn(`[Cleanup] Failed to sync status for warp ${initialWarp.id}. Skipping further checks for this warp.`);
        // Consider if sync failure itself indicates a problem - potentially increment error count?
        skippedCount++;
        continue;
      }

      const currentRunpodStatus = syncedWarp.jobStatus;

      // If Runpod status is now definitively terminal, we're good. Sync handled balance.
      if (trulyTerminalStates.includes(currentRunpodStatus) || potentiallyStuckTerminalStates.includes(currentRunpodStatus)) {
        console.log(`[Cleanup] Warp ${syncedWarp.id} has terminal status '${currentRunpodStatus}' on Runpod. Skipping cancellation check.`);
        skippedCount++;
        continue;
      }

      // --- If Runpod status is STILL ACTIVE ---
      console.log(`[Cleanup] Warp ${syncedWarp.id} has active status '${currentRunpodStatus}' on Runpod. Evaluating cleanup rules...`);

      // Check 1: Stuck in initial states
      if (['IN_QUEUE', 'PENDING'].includes(currentRunpodStatus) && syncedWarp.createdAt < stuckTimeCutoff) {
        needsCancellation = true;
        reason = `Stuck in ${currentRunpodStatus} since ${syncedWarp.createdAt.toISOString()}`;
      }
      // Check 2: Running but inactive (no recent heartbeat)
      else if (currentRunpodStatus === 'IN_PROGRESS' && syncedWarp.updatedAt < inactivityCutoff) {
        needsCancellation = true;
        reason = `Inactive IN_PROGRESS (last update: ${syncedWarp.updatedAt.toISOString()})`;
      }
      // Check 3: Discrepancy - DB thought it was terminal, but Runpod says it's active
      else if (potentiallyStuckTerminalStates.includes(initialDbStatus) && activeStates.includes(currentRunpodStatus)) {
          needsCancellation = true;
          reason = `Discrepancy: DB status was '${initialDbStatus}', but Runpod status is '${currentRunpodStatus}'`;
      }


      if (needsCancellation) {
        console.log(`[Cleanup] Triggering cancellation for warp ${syncedWarp.id} (User: ${syncedWarp.createdById}, Job: ${syncedWarp.jobId}). Reason: ${reason}`);
        await cancelWarpAndUpdateUserTimeBalance({
          userId: syncedWarp.createdById,
          warpId: syncedWarp.id,
          warp: syncedWarp, // Pass the synced warp object
        });
        console.log(`[Cleanup] Successfully initiated cancellation attempt for warp ${syncedWarp.id}.`);
        cancelAttemptCount++;
      } else {
         console.log(`[Cleanup] Warp ${syncedWarp.id} (Runpod Status: ${currentRunpodStatus}) does not meet cancellation criteria this cycle.`);
         skippedCount++;
      }

    } catch (error) {
      console.error(`[Cleanup] Error processing warp ${initialWarp.id} (Job: ${initialWarp.jobId}):`, error.message);
      // Don't count errors for jobs already terminal, as cancellation will fail expectedly.
      if (!error.message.includes('already in terminal state')) {
        errorCount++;
      } else {
        // If cancellation failed because it's now terminal, it's effectively handled.
        console.log(`[Cleanup] Cancellation attempt skipped for warp ${initialWarp.id}, now detected as terminal.`);
        skippedCount++;
        if (needsCancellation) cancelAttemptCount--; // Correct the count if we tried to cancel but it was already done
      }
    }
  }

  console.log(`[Cleanup] Finished. Cancellation Attempts: ${cancelAttemptCount}, Skipped/Healthy: ${skippedCount}, Errors: ${errorCount}`);
}
