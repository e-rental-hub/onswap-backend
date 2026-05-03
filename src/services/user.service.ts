
import { IUser, User } from "../models/User";
import { logger } from "../utils/logger";

export const register = async (username: string, piUid: string, kycVerified: boolean): Promise<IUser | null> => {
  try {

    const existing = await User.findOne({ $or: [{ username }, { piUid }] });
    if (existing) {
      logger.warn('User already exists with that username, or Pi UID' );
      return null;
    }

    const user = await User.create({ username, piUid, kycVerified });

    logger.info(`New user registered: ${username}`);
    return user
  } catch (error) {
    logger.error('Register error:', error);
    return null
  }
};