import fetch from 'node-fetch';
import { getSecret } from '#root/utils/secretUtils.js';

const NETWORK_VOLUMES = JSON.parse(getSecret('NETWORK_VOLUMES'));
const sortedVolumes = NETWORK_VOLUMES.sort((a, b) => a.priority - b.priority);

const PREFERRED_GPUS = getSecret('PREFERRED_GPUS').split(',');

const RUNPOD_TEMPLATE_ID = getSecret('RUNPOD_TEMPLATE_ID');

const runpodApiKey = process.env.RUNPOD_API_KEY;
const runpodApiEndpoint = `https://api.runpod.io/graphql${
  runpodApiKey ? `?api_key=${runpodApiKey}` : ''
}`;

const WEBHOOK_URL_BASE = await getSecret('WEBHOOK_URL_BASE');
const READY_WEBHOOK_URL = `${WEBHOOK_URL_BASE}/v1/webhooks/podready`;
const READY_WEBHOOK_SECRET_KEY = await getSecret('READY_WEBHOOK_SECRET_KEY');
const OPENAI_API_KEY = await getSecret('OPENAI_API_KEY');

export async function selectBestGpuVolumeAndDataCenter() {
  const dataCentersAndAvailability =
    await getRunpodDataCentersAndGpuAvailability();

  for (const volume of sortedVolumes) {
    const dataCenter = dataCentersAndAvailability.find(
      dc => dc.id === volume.dataCenter,
    );

    if (!dataCenter) continue;

    for (const preferredGpu of PREFERRED_GPUS) {
      const availableGpu = dataCenter.gpuAvailability.find(
        gpu =>
          gpu.gpuTypeDisplayName.includes(preferredGpu) &&
          ['High', 'Medium', 'Low'].includes(gpu.stockStatus),
      );

      if (availableGpu) {
        return {
          gpuType: availableGpu.id,
          volumeId: volume.id,
          dataCenterId: dataCenter.id,
        };
      }
    }
  }

  throw new Error(
    'No suitable GPU available in any of the preferred data centers',
  );
}

async function runGraphQLQuery({ query, variables = {} }) {
  const response = await fetch(runpodApiEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  const result = await response.json();
  // console.log('graphql resp1212');
  // console.dir(result, { depth: null, colors: true });

  if (result.errors) {
    console.error(
      'GraphQL error:',
      result.errors,
      result.errors?.[0]?.message || 'graphql error',
      result.errors?.[0]?.locations?.[0],
      result.errors?.[0]?.extensions,
    );
    throw new Error(result.errors?.[0]?.message || 'graphql error');
  }

  return result.data;
}

export async function getGpuTypes() {
  const query = `
    query GpuTypes {
      gpuTypes {
        id
        displayName
        memoryInGb
        secureCloud
        communityCloud
        lowestPrice(input: {gpuCount: 1}) {
          minimumBidPrice
          uninterruptablePrice
        }
      }
    }
  `;

  const data = await runGraphQLQuery({ query });
  return data.gpuTypes.filter(gpu => gpu.secureCloud);
}
export async function createRunpodPod({ gpuType, volumeId, dataCenterId }) {
  console.log('createRunpodPod1212', 'gpuType', gpuType, 'volumeId', volumeId);
  const query = `
    mutation PodCreate($input: PodFindAndDeployOnDemandInput!) {
      podFindAndDeployOnDemand(input: $input) {
        id
        imageName
        machineId
        machine {
          podHostId
        }
        desiredStatus
      }
    }
  `;

  const variables = {
    input: {
      cloudType: 'SECURE',
      gpuCount: 1,
      containerDiskInGb: 10,
      minVcpuCount: 6,
      minMemoryInGb: 16,
      gpuTypeId: gpuType,
      name: 'Dynamic Pod',
      templateId: RUNPOD_TEMPLATE_ID,
      dockerArgs: '',
      ports: '8888/http,22/tcp,8766/http,8765/http,5556/http,5559/http',
      volumeMountPath: '/workspace',
      networkVolumeId: volumeId,
      volumeInGb: 20,
      dataCenterId,
      env: [
        {
          key: 'READY_WEBHOOK_URL',
          value: READY_WEBHOOK_URL,
        },
        {
          key: 'READY_WEBHOOK_SECRET_KEY',
          value: READY_WEBHOOK_SECRET_KEY,
        },
        {
          key: 'OPENAI_API_KEY',
          value: OPENAI_API_KEY,
        },
      ],
    },
  };

  const data = await runGraphQLQuery({ query, variables });
  return data.podFindAndDeployOnDemand;
}

export async function getRunpodPod(podId) {
  console.log('Getting RunPod pod:', podId);
  const query = `
  query GetPod($input: PodFilter) {
    pod(input: $input) {
      id
      name
      desiredStatus
      imageName
      machineId
      gpuCount
      costPerHr
      createdAt
      lastStartedAt
      memoryInGb
      vcpuCount
      runtime {
        ports {
          ip
          isIpPublic
          privatePort
          publicPort
        }
      }
    }
  }
  `;

  const variables = {
    input: {
      podId: podId,
    },
  };

  try {
    const data = await runGraphQLQuery({ query, variables });
    console.log('Pod get result:', data);
    return data.pod;
  } catch (error) {
    console.error('Error getting pod:', error);
    throw error;
  }
}

export async function endRunpodPod(podId) {
  console.log('Ending RunPod pod:', podId);
  const query = `
    mutation PodTerminate($input: PodTerminateInput!) {
      podTerminate(input: $input)
    }
  `;

  const variables = {
    input: {
      podId: podId,
    },
  };

  try {
    const data = await runGraphQLQuery({ query, variables });
    // data will always be null
    console.log('Pod end result:', data);
    return data;
  } catch (error) {
    console.error('Error ending pod:', error);
    throw error;
  }
}

export async function getRunpodDataCentersAndGpuAvailability() {
  const query = `
    query DataCenters {
      dataCenters {
        id
        name
        location
        gpuAvailability {
          available
          stockStatus
          gpuTypeId
          gpuType {
            id
            displayName
          }
          gpuTypeDisplayName
          displayName
          id
        }
      }
    }
  `;

  const data = await runGraphQLQuery({ query });
  return data.dataCenters;
}

export async function planAndCreateRunpodPod() {
  const { gpuType, volumeId, dataCenterId } =
    await selectBestGpuVolumeAndDataCenter();
  // console.log('testSelectBestGpuVolumeAndDataCenter1212', gpuType, volumeId);
  const podMeta = await createRunpodPod({ gpuType, volumeId, dataCenterId });
  return { ...podMeta, gpuType, volumeId, dataCenterId };
}
