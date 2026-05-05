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

  // Pi Network SDK / escrow service endpoints (set in .env)
  piApiKey: process.env.PI_API_KEY ?? "CHANGEME",
  piNetworkApiBase: process.env.PI_NETWORK_API_BASE ?? "https://api.minepi.com",

  // MapCap IPO wallet (Pi address controlled by Map of Pi)
  appWalletAddress: process.env.IPO_WALLET_ADDRESS ?? "MAPCAP_IPO_WALLET",
  appWalletSecretSeed: process.env.IPO_WALLET_SECRET_SEED ?? "",
  
  mapOfPiWalletAddress: process.env.MAPOFPI_WALLET_ADDRESS ?? "MAPOFPI_WALLET",
} as const;
