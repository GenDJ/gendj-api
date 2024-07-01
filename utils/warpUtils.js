import { endRunpodPod } from '#root/utils/graphqlUtils.js';
import { appPrismaClient } from '#root/utils/prismaUtils.js';

// Function to check Warp entities
export async function checkWarpEntities() {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

  const warps = await appPrismaClient.warp.findMany({
    where: {
      podStatus: 'RUNNING',
      updatedAt: {
        lt: fiveMinutesAgo,
      },
    },
    select: {
      id: true,
      podId: true,
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
      console.error(`Failed to end pod for Warp ${warp.id}:`, error);
      // If ending fails, we don't update the Warp status
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

  if (!warp.podReadyAt || !warp.podEndedAt) {
    throw new Error(`Pod not yet marked as ready or ended for Warp ${warpId}`);
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

  const warpDuration = warp.podEndedAt - warp.podReadyAt;
  const warpDurationMinutes = warpDuration / 1000 / 60;

  const updatedTimeBalance = user.timeBalance - warpDurationMinutes;

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

  const user = await tx.user.update({
    where: { id: userId },
    data: { timeBalance: updatedTimeBalance },
  });

  return user;
}

// warp is optional
export async function endWarpAndUpdateUserTimeBalance({
  userId,
  warpId,
  warp = null,
}) {
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

  const ended = await appPrismaClient.$transaction(async tx => {
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
}
