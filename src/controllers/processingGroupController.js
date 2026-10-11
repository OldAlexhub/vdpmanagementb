import Division from '../models/Division.js';
import { getCompanySettings } from '../models/CompanySettings.js';
import { badRequest } from '../services/errors.js';

const view = async () => {
  const settings = await getCompanySettings();
  const groups = settings.processingGroups || [];
  const ids = groups.flatMap((group) => group.divisionIds.map(String));
  const divisions = await Division.find({ _id: { $in: ids } }, 'divisionNumber name status');
  const byId = new Map(divisions.map((division) => [String(division._id), division]));
  return groups.map((group) => ({
    _id: group._id,
    name: group.name,
    divisionIds: group.divisionIds.map(String),
    divisions: group.divisionIds.map((id) => byId.get(String(id))).filter(Boolean),
  }));
};

export async function list(_req, res) {
  res.json(await view());
}

export async function update(req, res) {
  if (!Array.isArray(req.body?.groups)) throw badRequest('Send the complete processing group list.');
  const groups = req.body.groups.map((group, index) => ({
    name: String(group.name || '').trim(),
    divisionIds: [...new Set((group.divisionIds || []).map(String).filter(Boolean))],
    index,
  }));
  for (const group of groups) {
    if (!group.name) throw badRequest(`Processing group ${group.index + 1} needs a name.`);
    if (group.divisionIds.length < 2 || group.divisionIds.length > 3) {
      throw badRequest(`“${group.name}” must contain two or three divisions.`);
    }
  }
  const used = new Set();
  for (const group of groups) {
    for (const id of group.divisionIds) {
      if (used.has(id)) throw badRequest('A division can belong to only one processing group.');
      used.add(id);
    }
  }
  const found = await Division.find({ _id: { $in: [...used] }, status: 'ACTIVE' }, '_id');
  if (found.length !== used.size) throw badRequest('Every grouped division must be an active Compass division.');
  const settings = await getCompanySettings();
  settings.processingGroups = groups.map(({ name, divisionIds }) => ({ name, divisionIds }));
  await settings.save();
  res.json(await view());
}
