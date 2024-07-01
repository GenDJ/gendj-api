// yeah I know this isn't how tests work I don't care

import {
  selectBestGpuVolumeAndDataCenter,
  planAndCreateRunpodPod,
  endRunpodPod,
} from '#root/utils/graphqlUtils.js';

const testSelectBestGpuVolumeAndDataCenter = async () => {
  const { gpu, volume } = await selectBestGpuVolumeAndDataCenter();
  console.log('testSelectBestGpuVolumeAndDataCenter1212', gpu, volume);
};

// THIS ACTUALLY CREATES A POD
const testPlanAndCreatePod = async () => {
  const podMeta = await planAndCreateRunpodPod();
  console.log('testCreatePod1212', podMeta);
};

// await testSelectBestGpuVolumeAndDataCenter();
// await testCreatePod();
// await endRunpodPod('m2uzvmys0f9703');
// await testPlanAndCreatePod();
// getRunpodDataCenters();
