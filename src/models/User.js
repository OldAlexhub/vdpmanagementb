import mongoose from 'mongoose';
import { jsonOptions } from './common.js';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    // ADMIN / USER = Big Star staff. PROVIDER = provider portal login, limited to one provider.
    role: { type: String, enum: ['ADMIN', 'USER', 'PROVIDER'], default: 'USER' },
    providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', default: null, index: true },
    active: { type: Boolean, default: true },
  },
  jsonOptions,
);

export default mongoose.model('User', userSchema);
