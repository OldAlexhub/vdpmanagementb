import mongoose from 'mongoose';
import { jsonOptions } from './common.js';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    // USER is retained only for pre-rebuild development databases and is
    // treated as Accounting. Clean production bootstraps use the named roles.
    role: { type: String, enum: ['ADMIN', 'ACCOUNTING', 'NSM', 'PROVIDER', 'USER'], default: 'ACCOUNTING' },
    providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', default: null, index: true },
    active: { type: Boolean, default: true },
    failedLoginAttempts: { type: Number, default: 0, select: false },
    lockedUntil: { type: Date, default: null, select: false },
    passwordChangedAt: { type: Date, default: Date.now },
    sessionVersion: { type: Number, default: 1, select: false },
  },
  jsonOptions,
);

export default mongoose.model('User', userSchema);
