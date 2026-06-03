import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../models/User';
import { logger } from '../utils/logger';
import { ZodSchema } from 'zod';

const JWT_SECRET = process.env.JWT_SECRET || 'pi-p2p-secret-change-me';

// ─── Extended request type ────────────────────────────────────────────────────

export interface AuthRequest extends Request {
  user?: {
    id: string;
    piUid: string;
    username: string;
  };
}

// ─── JWT authentication guard ─────────────────────────────────────────────────

// authenticate middleware — reads cookie first, falls back to Bearer header
export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // FIX 3: Prefer httpOnly cookie; fall back to Bearer for any non-browser
    // clients (e.g. mobile app, API consumers) during transition
    const token =
      req.cookies?.token ??
      req.headers.authorization?.replace('Bearer ', '');

    // Temporary debug log — remove after confirming
    // logger.debug(`auth: cookie=${!!req.cookies?.token} header=${!!req.headers.authorization} resolved=${!!token}`);

    if (!token) {
      res.status(401).json({ success: false, message: 'No token provided' });
      return;
    }

    const decoded = jwt.verify(token, JWT_SECRET) as {
      id: string;
      piUid: string;
      username: string;
    };

    const exists = await User.exists({ _id: decoded.id, piUid: decoded.piUid });
    if (!exists) {
      res.status(401).json({ success: false, message: 'Account not found' });
      return;
    }

    req.user = { id: decoded.id, piUid: decoded.piUid, username: decoded.username };
    next();
  } catch (err) {
    logger.warn('JWT verification failed:', err instanceof Error ? err.message : err);
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

// ─── Zod body validator ───────────────────────────────────────────────────────

export const validateBody = (schema: ZodSchema) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: result.error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        })),
      });
      return;
    }
    req.body = result.data;
    next();
  };
