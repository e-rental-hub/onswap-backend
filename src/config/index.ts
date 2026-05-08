import dotenv from "dotenv";
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  port: parseInt(process.env.PORT ?? "4000", 10),
  mongoUri: process.env.MONGO_URI ?? "mongodb://localhost:27017/mapcap",
  nodeEnv: process.env.NODE_ENV ?? "development",
  jwtSecret: process.env.JWT_SECRET ?? "",
  jwtExpires: process.env.JWT_EXPIRES || '24h',

  // Pi Network SDK / escrow service endpoints (set in .env)
  piApiKey: process.env.PI_API_KEY ?? "CHANGEME",
  piNetworkApiBase: process.env.PLATFORM_API_URL ?? "https://api.minepi.com",
  piNetwork: process.env.PI_NETWORK ?? "testnet",

  // MapCap IPO wallet (Pi address controlled by Map of Pi)
  appWalletAddress: process.env.WALLET_PUBLIC_SEED ?? "ONSWAP_WALLET_ADDRESS",
  appWalletSecretSeed: process.env.WALLET_PRIVATE_SEED ?? "ONSWAP_SECRET_SEED",
  appWalletPassphrase: process.env.WALLET_PASSPHRASE
  
} as const;
