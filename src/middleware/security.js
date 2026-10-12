import crypto from 'node:crypto';
import { HttpError } from '../services/errors.js';

const loginAttempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 20;

export function loginThrottle(req, _res, next) {
  const key = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = loginAttempts.get(key);
  const current = !entry || entry.resetAt <= now ? { count: 0, resetAt: now + WINDOW_MS } : entry;
  current.count += 1;
  loginAttempts.set(key, current);
  if (current.count > MAX_ATTEMPTS) return next(new HttpError(429, 'Too many sign-in attempts. Try again later.'));
  return next();
}

export function csrfProtection(allowedOrigins) {
  return (req, _res, next) => {
    if (process.env.NODE_ENV !== 'production' || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (!req.cookies?.vdp_session || ['/api/auth/login', '/api/auth/setup'].includes(req.path)) return next();
    const origin = String(req.get('origin') || '').replace(/\/+$/, '');
    if (!origin || !allowedOrigins.includes(origin) || req.get('x-vdp-csrf') !== '1') {
      return next(new HttpError(403, 'The request could not be verified. Refresh the page and try again.'));
    }
    return next();
  };
}

export function structuredRequestLog(req, res, next) {
  const requestId = req.get('x-request-id') || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  const startedAt = Date.now();
  res.on('finish', () => {
    if (process.env.NODE_ENV === 'test') return;
    process.stdout.write(`${JSON.stringify({
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      event: 'http_request',
      requestId,
      method: req.method,
      path: req.originalUrl?.split('?')[0],
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      userId: req.user?._id ? String(req.user._id) : null,
    })}\n`);
  });
  next();
}
