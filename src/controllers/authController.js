import bcrypt from 'bcrypt';
import User from '../models/User.js';
import Provider from '../models/Provider.js';
import { issueSession, COOKIE, cookieOptions } from '../middleware/auth.js';
import { badRequest, conflict, notFound, HttpError } from '../services/errors.js';

const publicUser = (u) => ({ _id: u._id, name: u.name, email: u.email, role: u.role === 'USER' ? 'ACCOUNTING' : u.role, active: u.active, providerId: u.providerId || null });

function checkPassword(pw) {
  if (!pw || String(pw).length < 12) throw badRequest('Password must be at least 12 characters.');
}

export async function status(_req, res) {
  res.json({ needsSetup: (await User.countDocuments()) === 0 });
}

// First run only: create the first administrator.
export async function setup(req, res) {
  if ((await User.countDocuments()) > 0) throw conflict('The application is already set up. Please sign in.');
  const { name, email, password } = req.body;
  if (!name || !email) throw badRequest('Name and email are required.');
  checkPassword(password);
  const user = await User.create({ name, email, role: 'ADMIN', passwordHash: await bcrypt.hash(password, 12) });
  issueSession(res, user);
  res.status(201).json(publicUser(user));
}

export async function login(req, res) {
  const { email, password } = req.body;
  const user = await User.findOne({ email: String(email || '').toLowerCase().trim() })
    .select('+passwordHash +failedLoginAttempts +lockedUntil +sessionVersion');
  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    throw new HttpError(429, 'This account is temporarily locked after repeated sign-in failures. Try again later.');
  }
  const valid = Boolean(user?.active) && await bcrypt.compare(String(password || ''), user?.passwordHash || '$2b$12$000000000000000000000uGqD7lN0tbbM5QdY8d9t8bY8bY8bY8b');
  if (!valid) {
    if (user) {
      user.failedLoginAttempts = Number(user.failedLoginAttempts || 0) + 1;
      if (user.failedLoginAttempts >= 5) {
        user.lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
        user.failedLoginAttempts = 0;
      }
      await user.save();
    }
    throw new HttpError(401, 'Email or password is incorrect.');
  }
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  await user.save();
  issueSession(res, user);
  res.json(publicUser(user));
}

export function logout(_req, res) {
  res.clearCookie(COOKIE, cookieOptions());
  res.json({ ok: true });
}

export async function me(req, res) {
  const out = publicUser(req.user);
  if (req.user.role === 'PROVIDER') out.providerName = (await Provider.findById(req.user.providerId, 'name'))?.name;
  res.json(out);
}

export async function changePassword(req, res) {
  const user = await User.findById(req.user._id).select('+passwordHash +sessionVersion');
  if (!(await bcrypt.compare(String(req.body.currentPassword || ''), user.passwordHash))) {
    throw badRequest('Current password is incorrect.');
  }
  checkPassword(req.body.newPassword);
  user.passwordHash = await bcrypt.hash(req.body.newPassword, 12);
  user.passwordChangedAt = new Date();
  user.sessionVersion = Number(user.sessionVersion || 1) + 1;
  await user.save();
  issueSession(res, user);
  res.json({ ok: true });
}

// ?providerId=… lists that provider's portal logins; otherwise Big Star staff.
export async function listUsers(req, res) {
  const filter = req.query.providerId ? { role: 'PROVIDER', providerId: req.query.providerId } : { role: { $in: ['ADMIN', 'ACCOUNTING', 'NSM', 'USER'] } };
  res.json((await User.find(filter).sort({ name: 1 })).map(publicUser));
}

export async function createUser(req, res) {
  const { name, email, password, role, providerId } = req.body;
  if (!name || !email) throw badRequest('Name and email are required.');
  checkPassword(password);
  let provider = null;
  if (role === 'PROVIDER') {
    provider = await Provider.findById(providerId);
    if (!provider) throw badRequest('Choose the provider this login belongs to.');
  }
  const user = await User.create({
    name,
    email,
    role: provider ? 'PROVIDER' : ['ADMIN', 'ACCOUNTING', 'NSM'].includes(role) ? role : 'ACCOUNTING',
    providerId: provider?._id ?? null,
    passwordHash: await bcrypt.hash(password, 12),
  });
  res.status(201).json(publicUser(user));
}

export async function updateUser(req, res) {
  const user = await User.findById(req.params.id);
  if (!user) throw notFound('User');
  if (String(user._id) === String(req.user._id) && (req.body.active === false || (req.body.role && req.body.role !== 'ADMIN'))) {
    throw badRequest('You cannot deactivate or demote your own account.');
  }
  if (req.body.name !== undefined) user.name = req.body.name;
  if (req.body.role !== undefined && user.role !== 'PROVIDER') user.role = ['ADMIN', 'ACCOUNTING', 'NSM'].includes(req.body.role) ? req.body.role : 'ACCOUNTING';
  if (req.body.active !== undefined) user.active = Boolean(req.body.active);
  if (req.body.password) {
    checkPassword(req.body.password);
    user.passwordHash = await bcrypt.hash(req.body.password, 12);
    user.passwordChangedAt = new Date();
    user.sessionVersion = Number(user.sessionVersion || 1) + 1;
  }
  await user.save();
  res.json(publicUser(user));
}
