import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { HttpError } from '../services/errors.js';

export const COOKIE = 'vdp_session';

export const jwtSecret = () => {
  const s = process.env.JWT_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET must be set in production.');
  return 'dev-only-secret-change-me';
};

// COOKIE_SAME_SITE=none lets a client hosted on another site send the session (requires HTTPS).
export const cookieOptions = () => {
  const sameSite = (process.env.COOKIE_SAME_SITE || 'lax').toLowerCase();
  return { httpOnly: true, sameSite, secure: sameSite === 'none' || process.env.NODE_ENV === 'production' };
};

export function issueSession(res, user) {
  const token = jwt.sign({ sub: String(user._id) }, jwtSecret(), { expiresIn: '12h' });
  res.cookie(COOKIE, token, { ...cookieOptions(), maxAge: 12 * 60 * 60 * 1000 });
}

export async function requireAuth(req, _res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return next(new HttpError(401, 'Please sign in.'));
  try {
    const { sub } = jwt.verify(token, jwtSecret());
    const user = await User.findById(sub);
    if (!user || !user.active) return next(new HttpError(401, 'Please sign in.'));
    req.user = user;
    return next();
  } catch {
    return next(new HttpError(401, 'Your session has expired. Please sign in again.'));
  }
}

export const requireAdmin = (req, _res, next) =>
  req.user?.role === 'ADMIN' ? next() : next(new HttpError(403, 'Only administrators can do this.'));

// Everything outside the provider portal is for Big Star staff only.
export const requireStaff = (req, _res, next) =>
  ['ADMIN', 'USER'].includes(req.user?.role) ? next() : next(new HttpError(403, 'This page is for Big Star staff.'));

export const requireProvider = (req, _res, next) =>
  req.user?.role === 'PROVIDER' && req.user.providerId
    ? next()
    : next(new HttpError(403, 'The provider portal is for provider accounts.'));
