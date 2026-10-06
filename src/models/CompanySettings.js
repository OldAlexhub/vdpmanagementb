import mongoose from 'mongoose';
import { jsonOptions } from './common.js';

// Company-wide settings (a single document). VDP cycles run on one schedule for every division.
const companySettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'company', unique: true },
    cycleSettings: {
      anchorDate: { type: Date, default: () => new Date('2026-08-24T00:00:00Z') }, // any known cycle start (a Monday)
      lengthDays: { type: Number, default: 14, enum: [14] },
      submissionOffsetDays: { type: Number, default: 15, min: 0 },
      paymentOffsetDays: { type: Number, default: 4, min: 0 },
    },
    compassRoster: {
      automaticSyncEnabled: { type: Boolean, default: true },
      syncIntervalMinutes: { type: Number, default: 15, min: 1, max: 1440 },
      lastAttemptAt: { type: Date, default: null },
      lastSyncAt: { type: Date, default: null },
      lastSyncStatus: { type: String, enum: ['NEVER', 'RUNNING', 'SUCCESS', 'FAILED'], default: 'NEVER' },
      lastError: { type: String, default: null },
      lastSummary: { type: mongoose.Schema.Types.Mixed, default: null },
    },
  },
  jsonOptions,
);

const CompanySettings = mongoose.model('CompanySettings', companySettingsSchema);

// The settings document, created on first use. Before cycles were company-wide each division
// had its own schedule; the first time, the oldest division's schedule is carried over.
export async function getCompanySettings() {
  const found = await CompanySettings.findOne({ key: 'company' });
  if (found) return found;
  const Division = mongoose.model('Division');
  const first = await Division.findOne({ 'cycleSettings.anchorDate': { $ne: null } }).sort({ createdAt: 1 });
  const cs = first?.cycleSettings;
  try {
    return await CompanySettings.create({
      key: 'company',
      ...(cs ? { cycleSettings: { anchorDate: cs.anchorDate, lengthDays: 14, submissionOffsetDays: cs.submissionOffsetDays, paymentOffsetDays: cs.paymentOffsetDays } } : {}),
    });
  } catch (e) {
    if (e.code === 11000) return CompanySettings.findOne({ key: 'company' }); // created concurrently
    throw e;
  }
}

export default CompanySettings;
