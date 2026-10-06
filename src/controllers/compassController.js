import { compassConfigView, testCompassConnection } from '../services/compassClient.js';
import {
  compassRosterSettings, previewCompassRoster, syncCompassRoster, updateCompassRosterSettings,
} from '../services/compassRosterService.js';

export async function status(_req, res) {
  res.json({ ...compassConfigView(), roster: await compassRosterSettings() });
}

export async function test(_req, res) {
  res.json(await testCompassConnection());
}

export async function preview(_req, res) {
  res.json(await previewCompassRoster());
}

export async function sync(_req, res) {
  res.json(await syncCompassRoster());
}

export async function updateSettings(req, res) {
  res.json(await updateCompassRosterSettings(req.body));
}
