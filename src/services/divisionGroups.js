import Division from '../models/Division.js';
import { getCompanySettings } from '../models/CompanySettings.js';

export const divisionNumberKey = (value) => String(value || '').trim().toUpperCase().replace(/\s+/g, '');

export const isDivision3Number = (value) => ['3', '3GL'].includes(divisionNumberKey(value));

export const isDivision3Division = (division) => isDivision3Number(division?.divisionNumber);

// Processing groups are configured by Accounting. The first division in the
// saved group owns the cycle used for the combined run; every member keeps its
// own Compass roster, plan assignments, and division identity.
export async function processingDivisionsFor(division) {
  if (!division) return [];
  const settings = await getCompanySettings();
  const group = settings.processingGroups.find((item) => item.divisionIds.some((id) => String(id) === String(division._id)));
  if (!group) return [division];
  const members = await Division.find({ _id: { $in: group.divisionIds }, status: 'ACTIVE' });
  const byId = new Map(members.map((item) => [String(item._id), item]));
  return group.divisionIds.map((id) => byId.get(String(id))).filter(Boolean);
}

export async function processingDivisionIdsForCycle(cycle) {
  const division = await Division.findById(cycle.divisionId);
  const divisions = await processingDivisionsFor(division);
  return { division, divisions, divisionIds: divisions.map((item) => item._id) };
}
