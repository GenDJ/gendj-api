// yeah I know this isn't how tests work I don't care

import {
  selectBestGpuVolumeAndDataCenter,
  planAndCreateRunpodPod,
  endRunpodPod,
  getRunpodPod,
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

const testGetRunpodPod = async podId => {
  const pods = await getRunpodPod(podId);
  console.log('testGetRunpodPods1212', pods);
};

// await testSelectBestGpuVolumeAndDataCenter();
// await testCreatePod();
// await endRunpodPod('');
// await testPlanAndCreatePod();
// await testGetRunpodPod('');
// getRunpodDataCenters();
