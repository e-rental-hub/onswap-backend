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
  escrowPiApiBase: process.env.ESCROWPI_API_BASE ?? "https://api.escrowpi.io",
  escrowPiApiKey: process.env.ESCROWPI_API_KEY ?? "CHANGEME",

  // MapCap tokenomics
  totalSupply: 4_000_000,
  ipoMapcap: 2_181_818,
  lpMapcap: 1_818_182,

  // IPO phase: fixed 28-day calendar month window
  ipoStartDate: new Date(process.env.IPO_START_DATE ?? "2026-04-01T00:00:00Z"),
  ipoEndDate:   new Date(process.env.IPO_END_DATE   ?? "2026-04-28T00:00:00Z"),

  // Anti-whale cap
  whaleCapPct: 0.10,        // 10% of total pool
  dividendCapPct: 0.10,     // 10% of total MapCap held

  // Dividend share of profits paid out
  dividendProfitSharePct: 0.10,

  // MapCap IPO wallet (Pi address controlled by Map of Pi)
  ipoWalletAddress: process.env.IPO_WALLET_ADDRESS ?? "MAPCAP_IPO_WALLET",
  ipoWalletSecretSeed: process.env.IPO_WALLET_SECRET_SEED ?? "",
  
  mapOfPiWalletAddress: process.env.MAPOFPI_WALLET_ADDRESS ?? "MAPOFPI_WALLET",
} as const;
