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
    // Select all fields needed for comparison and potential updates
    select: {
      id: true,
      jobId: true,
      jobStatus: true,
      jobStartedAt: true,
      jobEndedAt: true,
      workerId: true,
      createdById: true, // Needed for balance update later
      runpodConfirmedTerminal: true, // Added field
      updatedAt: true, // Needed for return value consistency
      createdAt: true, // Needed for return value consistency
    },
  });

  if (!warp || !warp.jobId) {
    console.log(`Warp ${warpId} not found or has no job ID. Skipping status sync.`);
    return null;
  }

  const terminalStates = ['COMPLETED', 'FAILED', 'CANCELLED', 'ENDED'];

  // If already terminal in DB AND confirmed by Runpod, skip API sync.
  if (terminalStates.includes(warp.jobStatus) && warp.runpodConfirmedTerminal) {
    // console.log(`Warp ${warpId} is already in a confirmed terminal state ${warp.jobStatus}. Skipping API sync.`);
    return warp; // Return the existing warp data
  }

  try {
    console.log(`[SyncWarp] Calling getRunpodServerlessJobStatus for job ${warp.jobId}...`);
    const jobStatusResult = await getRunpodServerlessJobStatus(warp.jobId);
    console.log(`[SyncWarp] Raw response for job ${warp.jobId}:`, JSON.stringify(jobStatusResult)); // Less verbose logging

    const { status, workerId, delayTime, executionTime } = jobStatusResult;

    let needsUpdate = false;
    const updateData = {};

    // Check if status changed
    if (status !== warp.jobStatus) {
      updateData.jobStatus = status;
      needsUpdate = true;
      console.log(`[SyncWarp] Status change detected for ${warp.id}: ${warp.jobStatus} -> ${status}`);
      // If the new status is terminal, mark it as confirmed
      if (terminalStates.includes(status)) {
        updateData.runpodConfirmedTerminal = true;
         console.log(`[SyncWarp] Marking warp ${warp.id} as runpodConfirmedTerminal.`);
      }
    }

    // Check if workerId changed (and is not null/undefined)
    const newWorkerId = workerId || warp.workerId; // Use new one if available
    if (newWorkerId !== warp.workerId) {
      updateData.workerId = newWorkerId;
      needsUpdate = true;
       console.log(`[SyncWarp] WorkerId change detected for ${warp.id}: ${warp.workerId} -> ${newWorkerId}`);
    }

    // Check if jobStartedAt needs setting
    let estimatedStartedAt = null;
    if (status === 'IN_PROGRESS' && !warp.jobStartedAt) {
       estimatedStartedAt = new Date(Date.now() - (delayTime || 0) * 1000);
       updateData.jobStartedAt = estimatedStartedAt;
       needsUpdate = true;
       console.log(`[SyncWarp] Setting jobStartedAt for Warp ${warpId} (Job ${warp.jobId}) based on IN_PROGRESS status.`);
    }

    // Check if jobEndedAt needs setting
    let estimatedEndedAt = null;
    if (terminalStates.includes(status) && !warp.jobEndedAt) {
       // Use the estimatedStartedAt if calculated in this run, otherwise fetch it from warp
       const start = estimatedStartedAt || warp.jobStartedAt;
       if (start) { // Only calculate end time if we have a start time
           estimatedEndedAt = new Date(start.getTime() + (executionTime || 0) * 1000);
           // Ensure end time is not before start time
           if (estimatedEndedAt < start) {
               console.warn(`[SyncWarp] Calculated end time ${estimatedEndedAt.toISOString()} is before start time ${start.toISOString()} for job ${warp.jobId}. Using current time as fallback.`);
               estimatedEndedAt = new Date(); // Fallback to current time
           }
           updateData.jobEndedAt = estimatedEndedAt;
           needsUpdate = true;
           console.log(`[SyncWarp] Setting jobEndedAt for Warp ${warpId} (Job ${warp.jobId}) based on ${status} status.`);
           // Also mark as confirmed if setting end time based on terminal status
           if (!updateData.runpodConfirmedTerminal) {
             updateData.runpodConfirmedTerminal = true;
              console.log(`[SyncWarp] Marking warp ${warp.id} as runpodConfirmedTerminal (triggered by setting jobEndedAt).`);
           }
       } else {
            console.warn(`[SyncWarp] Cannot set jobEndedAt for job ${warp.jobId} in status ${status} because jobStartedAt is missing.`);
            // If we couldn't set jobEndedAt but status is terminal, still mark confirmed if status changed
            if (terminalStates.includes(status) && status !== warp.jobStatus && !updateData.runpodConfirmedTerminal) {
               updateData.runpodConfirmedTerminal = true;
               needsUpdate = true; // Need to update to set the flag
               console.log(`[SyncWarp] Marking warp ${warp.id} as runpodConfirmedTerminal (status is terminal, but endedAt couldn't be set).`);
            }
       }
    }

    // Final check: If status is terminal, flag is false, but nothing else triggered an update,
    // we still need to update to set the flag true.
    if (terminalStates.includes(status) && !warp.runpodConfirmedTerminal && !needsUpdate) {
        console.log(`[SyncWarp] Forcing update for warp ${warp.id} to set runpodConfirmedTerminal=true (Status: ${status})`);
        updateData.runpodConfirmedTerminal = true;
        // Ensure jobStatus is included if not already, maintaining consistency
        if (!updateData.jobStatus) updateData.jobStatus = status;
        needsUpdate = true;
    }

    let finalWarp = warp; // Start with the initially fetched warp

    if (needsUpdate) {
      console.log(`[SyncWarp] Updating warp ${warpId} in DB. Changes:`, Object.keys(updateData));
      finalWarp = await appPrismaClient.warp.update({
        where: { id: warpId },
        data: updateData,
        // Return the full object after update including the new flag
        select: {
            id: true, jobId: true, jobStatus: true, jobStartedAt: true,
            jobEndedAt: true, workerId: true, createdById: true, updatedAt: true, createdAt: true,
            runpodConfirmedTerminal: true
        }
      });

      // If the job just reached a terminal state *in this update* AND was confirmed,
      // finalize the user's balance. Check finalWarp.runpodConfirmedTerminal for safety.
      if (finalWarp.runpodConfirmedTerminal && terminalStates.includes(finalWarp.jobStatus) && finalWarp.jobEndedAt && finalWarp.jobStartedAt && status !== warp.jobStatus) {
        console.log(`[SyncWarp] Job ${finalWarp.jobId} reached confirmed terminal state ${finalWarp.jobStatus}. Finalizing time balance for user ${finalWarp.createdById}.`);
        try {
            await appPrismaClient.$transaction(async (tx) => {
                await updateUserTimeBalanceForEndedWarp({
                    tx,
                    userId: finalWarp.createdById,
                    warp: finalWarp, // Pass the fully updated warp object
                });
            });
             console.log(`[SyncWarp] Successfully finalized balance for user ${finalWarp.createdById} for job ${finalWarp.jobId}.`);
        } catch (balanceError) {
             console.error(`[SyncWarp] Error finalizing balance for user ${finalWarp.createdById} for job ${finalWarp.jobId}:`, balanceError);
             // Decide how to handle this - maybe retry later? For now, log and continue.
        }
      }
    } else {
      // console.log(`[SyncWarp] No relevant changes detected for warp ${warpId} (Status: ${status}). Skipping DB update.`);
    }

    // console.log(`Synced status for Warp ${warpId} (Job ${warp.jobId}): ${finalWarp.jobStatus}`);
    return finalWarp; // Return the latest warp data (either original or updated)
  } catch (error) {
    console.error(`Error syncing status for Warp ${warpId} (Job ${warp.jobId}):`, error);

    // Check if it's a 404 error from Runpod for a job already terminal in our DB
    const isNotFoundError = error.message && error.message.includes('Not Found') && error.message.includes('request does not exist');
    const isDbTerminal = terminalStates.includes(warp.jobStatus);

    if (isNotFoundError && isDbTerminal) {
      console.log(`[SyncWarp] Runpod API returned 404 for DB terminal warp ${warpId} (Status: ${warp.jobStatus}). Assuming purged and marking as confirmed.`);
      try {
        const confirmedWarp = await appPrismaClient.warp.update({
          where: { id: warpId },
          data: { runpodConfirmedTerminal: true },
          select: { // Return the full object consistent with successful sync
            id: true, jobId: true, jobStatus: true, jobStartedAt: true,
            jobEndedAt: true, workerId: true, createdById: true, updatedAt: true, createdAt: true,
            runpodConfirmedTerminal: true
          }
        });
        return confirmedWarp; // Return the updated warp object
      } catch (updateError) {
        console.error(`[SyncWarp] Failed to mark warp ${warpId} as confirmed after 404 error:`, updateError);
        // Fall through to return null if update fails
      }
    }

    // Optionally update warp status to UNKNOWN or ERROR_SYNCING for other errors
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
  const inactivityThresholdMinutes = 5; // Max time since last *actual change* for an IN_PROGRESS job
  // Removed recheckTerminalMinutes as we now rely on the runpodConfirmedTerminal flag

  const now = new Date();
  const stuckTimeCutoff = new Date(now.getTime() - stuckThresholdMinutes * 60 * 1000);
  const inactivityCutoff = new Date(now.getTime() - inactivityThresholdMinutes * 60 * 1000);
  // Removed recheckTerminalCutoff

  // Define states
  const terminalStates = ['COMPLETED', 'FAILED', 'CANCELLED', 'ENDED'];
  const activeStates = ['IN_QUEUE', 'PENDING', 'IN_PROGRESS', 'PAUSED'];

  console.log('[Cleanup] Starting inactive/stuck/unconfirmed warp check...');

  // Fetch warps that are potentially active OR terminal but not yet confirmed by Runpod sync
  const warpsToCheck = await appPrismaClient.warp.findMany({
    where: {
      deletedAt: null,
      jobId: { not: null }, // Only check warps that have a job ID
      OR: [
        { jobStatus: { in: activeStates } }, // Actively supposed to be running/queued
        { jobStatus: null }, // Might have failed before status set
        {
          jobStatus: { in: terminalStates }, // Is terminal in our DB...
          runpodConfirmedTerminal: false,     // ...but we haven't confirmed it via API yet
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
      runpodConfirmedTerminal: true, // Need this for logic after sync
    },
  });

  if (warpsToCheck.length === 0) {
    console.log('[Cleanup] No warps found needing status check or confirmation.');
    return;
  }

  console.log(`[Cleanup] Found ${warpsToCheck.length} warps to check/confirm. Syncing status and evaluating...`);

  let cancelAttemptCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  for (const initialWarp of warpsToCheck) {
    let needsCancellation = false;
    let reason = '';
    const initialDbStatus = initialWarp.jobStatus;
    const wasConfirmedBeforeSync = initialWarp.runpodConfirmedTerminal;

    try {
      console.log(`[Cleanup] Syncing status for warp ${initialWarp.id} (Job: ${initialWarp.jobId}, DB Status: ${initialDbStatus || 'NULL'}, Confirmed: ${wasConfirmedBeforeSync})`);
      // syncWarpJobStatus now returns the latest warp data, including runpodConfirmedTerminal
      const syncedWarp = await syncWarpJobStatus(initialWarp.id);

      if (!syncedWarp) {
        console.warn(`[Cleanup] Failed to sync status for warp ${initialWarp.id}. Skipping further checks for this warp.`);
        skippedCount++;
        continue;
      }

      // If the sync confirmed the job is terminal, we're done with this one.
      if (syncedWarp.runpodConfirmedTerminal) {
        console.log(`[Cleanup] Warp ${syncedWarp.id} is now in confirmed terminal state '${syncedWarp.jobStatus}'. Skipping cancellation check.`);
        skippedCount++;
        continue;
      }

      // --- If Runpod status is STILL ACTIVE (or couldn't be confirmed as terminal by sync) ---
      const currentRunpodStatus = syncedWarp.jobStatus; // Status after sync attempt
      console.log(`[Cleanup] Warp ${syncedWarp.id} has non-confirmed status '${currentRunpodStatus}' after sync. Evaluating cleanup rules...`);

      // Check 1: Stuck in initial states
      if (activeStates.slice(0, 2).includes(currentRunpodStatus) && syncedWarp.createdAt < stuckTimeCutoff) { // IN_QUEUE, PENDING
        needsCancellation = true;
        reason = `Stuck in ${currentRunpodStatus} since ${syncedWarp.createdAt.toISOString()}`;
      }
      // Check 2: Running but inactive (updatedAt didn't change recently)
      // We rely on syncWarpJobStatus *not* updating the record if status didn't change.
      else if (currentRunpodStatus === 'IN_PROGRESS' && syncedWarp.updatedAt < inactivityCutoff) {
        needsCancellation = true;
        reason = `Inactive IN_PROGRESS (last change detected at: ${syncedWarp.updatedAt.toISOString()})`;
      }
      // Check 3: Discrepancy - DB thought it was terminal (but unconfirmed), sync shows it's active
      else if (terminalStates.includes(initialDbStatus) && !wasConfirmedBeforeSync && activeStates.includes(currentRunpodStatus)) {
          needsCancellation = true;
          reason = `Discrepancy: DB status was unconfirmed '${initialDbStatus}', Runpod sync shows active '${currentRunpodStatus}'`;
      }

      if (needsCancellation) {
        console.log(`[Cleanup] Triggering cancellation for warp ${syncedWarp.id} (User: ${syncedWarp.createdById}, Job: ${syncedWarp.jobId}). Reason: ${reason}`);
        try {
            await cancelWarpAndUpdateUserTimeBalance({
              userId: syncedWarp.createdById,
              warpId: syncedWarp.id,
              warp: syncedWarp, // Pass the synced warp object
            });
            console.log(`[Cleanup] Successfully initiated cancellation attempt for warp ${syncedWarp.id}.`);
            cancelAttemptCount++;
        } catch(cancelError) {
             console.error(`[Cleanup] Error during cancellation attempt for warp ${syncedWarp.id}:`, cancelError.message);
             // If cancellation failed because it's already terminal (race condition), treat as skipped
             if (cancelError.message && cancelError.message.includes('already in terminal state')) {
                 console.log(`[Cleanup] Cancellation failed because warp ${syncedWarp.id} reached terminal state concurrently.`);
                 // Ensure it gets marked confirmed on the next run if needed
                 skippedCount++;
             } else {
                 errorCount++; // Count other cancellation errors
             }
        }
      } else {
         console.log(`[Cleanup] Warp ${syncedWarp.id} (Status: ${currentRunpodStatus}) does not meet cancellation criteria this cycle.`);
         skippedCount++;
      }

    } catch (error) {
      // Catch errors from syncWarpJobStatus itself (e.g., API call failure)
      console.error(`[Cleanup] Error during sync/processing for warp ${initialWarp.id} (Job: ${initialWarp.jobId}):`, error.message);
      errorCount++;
    }
  }

  console.log(`[Cleanup] Finished. Cancellation Attempts: ${cancelAttemptCount}, Skipped/Confirmed: ${skippedCount}, Errors: ${errorCount}`);
}
