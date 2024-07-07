import { POD_STATUS } from '#root/utils/constants.js';
import { endRunpodPod } from '#root/utils/graphqlUtils.js';
import { appPrismaClient } from '#root/utils/prismaUtils.js';

// Function to check Warp entities
export async function checkWarpEntities() {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

  const warps = await appPrismaClient.warp.findMany({
    where: {
      podStatus: {
        in: ['RUNNING', 'PENDING'],
      },
      updatedAt: {
        lt: tenMinutesAgo,
      },
    },
    select: {
      id: true,
      podId: true,
      createdById: true,
    },
  });

  const updatePromises = warps.map(async warp => {
    try {
      await endWarpAndUpdateUserTimeBalance({
        userId: warp.createdById,
        warpId: warp.id,
      });
      console.log(`Successfully ended and updated Warp ${warp.id}`);
    } catch (error) {
      console.error(`Failed to end pod for Warp in utils ${warp.id}:`, error);
      if (error?.message?.includes('pod not found to terminate')) {
        try {
          await appPrismaClient.warp.update({
            where: { id: warp.id },
            data: { podStatus: POD_STATUS.DEAD },
          });
          console.log(
            `Updated status to ${POD_STATUS.DEAD} for Warp ${warp.id}`,
          );
        } catch (updateError) {
          console.error(
            `Failed to update status for Warp ${warp.id}:`,
            updateError,
          );
        }
      }
    }
  });

  // Wait for all update operations to complete
  await Promise.all(updatePromises);
}

// warp and tx are optional lol
export async function calculateUserTimeBalanceAfterWarp({
  tx = null,
  userId,
  warpId,
  warp = null,
}) {
  if (!warp) {
    if (tx) {
      warp = await tx.warp.findUnique({
        where: { id: warpId },
        select: {
          id: true,
          podReadyAt: true,
          podEndedAt: true,
        },
      });
    } else {
      warp = await appPrismaClient.warp.findUnique({
        where: { id: warpId },
        select: {
          id: true,
          podReadyAt: true,
          podEndedAt: true,
        },
      });
    }
  }

  if (!warp) {
    throw new Error(`Warp with ID ${warpId} not found`);
  }

  let user;
  if (tx) {
    user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        timeBalance: true,
      },
    });
  } else {
    user = await appPrismaClient.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        timeBalance: true,
      },
    });
  }

  if (!user) {
    throw new Error(`User with ID ${userId} not found`);
  }

  if (!warp.podReadyAt) {
    return user.timeBalance;
  }
  if (!warp.podEndedAt) {
    // return user.timeBalance (which is seconds) minus the time since warp.podReadyAt
    const currentTime = new Date();
    const timeSincePodReady =
      (currentTime.getTime() - warp.podReadyAt.getTime()) / 1000; // Convert to seconds
    return user.timeBalance - timeSincePodReady;
  }

  const warpDuration = warp.podEndedAt - warp.podReadyAt;
  const warpDurationSeconds = warpDuration / 1000;

  const updatedTimeBalance = user.timeBalance - warpDurationSeconds;

  return updatedTimeBalance;
}

// warp is optional
export async function updateUserTimeBalanceForEndedPod({
  tx,
  userId,
  warpId,
  warp,
}) {
  const updatedTimeBalance = await calculateUserTimeBalanceAfterWarp({
    tx,
    userId,
    warpId,
    warp,
  });
  console.log('updatedTimeBalance1212', updatedTimeBalance, userId);

  const user = await tx.user.update({
    where: { id: userId },
    data: { timeBalance: Math.ceil(updatedTimeBalance) },
  });

  console.log('updated user1212', user);

  return user;
}

/**
 * @param {Object} options
 * @param {string} options.userId
 * @param {string} options.warpId
 * @param {*=} [options.warp=null]
 */
export async function endWarpAndUpdateUserTimeBalance({
  userId,
  warpId,
  warp = null,
}) {
  if (!userId) {
    throw new Error('User ID is required');
  }
  if (!warp) {
    warp = await appPrismaClient.warp.findUnique({
      where: { id: warpId },
      select: {
        id: true,
        podId: true,
        podStatus: true,
      },
    });
  }

  await endRunpodPod(warp.podId);

  const { warp: endedWarp, user: updatedUser } =
    await appPrismaClient.$transaction(async tx => {
      const endedWarp = await tx.warp.update({
        where: { id: warpId },
        data: { podStatus: 'ENDED', podEndedAt: new Date() },
      });

      const updatedUser = await updateUserTimeBalanceForEndedPod({
        tx,
        userId,
        warpId,
        warp: endedWarp,
      });

      return { warp: endedWarp, user: updatedUser };
    });

  return { warp: endedWarp, user: updatedUser };
}
