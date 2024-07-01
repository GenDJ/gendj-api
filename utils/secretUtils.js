import dotenv from 'dotenv';
dotenv.config();

function getSecret(secretString) {
  if (!secretString) {
    throw new Error(`Cannot retrieve unspecified secret`);
  }

  const secret = process.env[secretString];

  if (!secret) {
    throw new Error(`secret ${secretString} expected but not found err71`);
  }

  return secret;
}

export { getSecret };
