import mongoose from 'mongoose';

const { Schema } = mongoose;

// Decimal128 field that serialises as an exact string (never a float).
export const dec = (extra = {}) => ({
  type: Schema.Types.Decimal128,
  get: (v) => (v === null || v === undefined ? v : v.toString()),
  ...extra,
});

export const jsonOptions = {
  toJSON: { getters: true, virtuals: true, versionKey: false, transform: (_doc, ret) => { delete ret.id; return ret; } },
  toObject: { getters: true, virtuals: true },
  timestamps: true,
};

// Who did something, for audit trails.
export const actorSchema = new Schema({ id: { type: Schema.Types.ObjectId, ref: 'User' }, name: String }, { _id: false });
