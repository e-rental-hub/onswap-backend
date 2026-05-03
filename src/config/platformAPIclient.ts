import axios from "axios";
import PiNetwork from 'pi-backend';
import { config } from "../config";

export const platformAPIClient = axios.create({
  baseURL: config.piNetworkApiBase,
  timeout: 20000,
  headers: {
    Authorization: `Key ${config.piApiKey}`,
  },
});

// const apiKey = env.PI_API_KEY || '';
// const walletSeed = env.IPO_WALLET_SECRET_SEED || '';

const piNetwork = new PiNetwork(config.piApiKey, config.ipoWalletSecretSeed);

export default piNetwork;