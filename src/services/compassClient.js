import { badRequest } from './errors.js';

const ENDPOINTS = Object.freeze({
  divisions: { path: '/api/divisions', key: 'divisions', query: { includeInactive: '1' } },
  operators: { path: '/api/operators', key: 'operators' },
  providers: { path: '/api/providers', key: 'providers' },
  runCuts: { path: '/api/run-cuts', key: 'runCuts', query: { includeStandby: '1' } },
});

const value = (name) => String(process.env[name] || '').trim();

function config() {
  const baseUrl = value('COMPASS_BASE_URL').replace(/\/+$/, '');
  const token = value('COMPASS_API_TOKEN').replace(/^Bearer\s+/i, '');
  const timeout = Math.max(3000, Math.min(Number(process.env.COMPASS_TIMEOUT_MS) || 20000, 60000));
  let parsed = null;
  if (baseUrl) {
    try { parsed = new URL(baseUrl); } catch { /* reported below */ }
  }
  const missing = [];
  const localHttp = parsed?.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (!parsed || (parsed.protocol !== 'https:' && !localHttp) || parsed.username || parsed.password || parsed.search || parsed.hash) missing.push('COMPASS_BASE_URL');
  if (!token) missing.push('COMPASS_API_TOKEN');
  return { baseUrl, token, timeout, missing, configured: missing.length === 0 };
}

export function compassConfigView() {
  const current = config();
  let host = null;
  try { host = current.baseUrl ? new URL(current.baseUrl).host : null; } catch { /* invalid config is reported in missing */ }
  return {
    configured: current.configured,
    host,
    tokenConfigured: Boolean(current.token),
    missing: current.missing,
  };
}

// Once configured, Compass owns roster identity. Automatic refresh can be paused in
// Settings, but that never re-enables manual roster maintenance by accident.
export function isCompassRosterAuthority() {
  // Node's test runner loads the developer .env in integration suites; those fixtures must
  // remain isolated from real external connections and continue exercising manual CRUD.
  return !process.env.NODE_TEST_CONTEXT && config().configured;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getCollection(name) {
  const current = config();
  if (!current.configured) {
    throw badRequest(`Compass API configuration is incomplete: ${current.missing.join(', ')}.`, {
      code: 'COMPASS_NOT_CONFIGURED', missing: current.missing,
    });
  }
  const endpoint = ENDPOINTS[name];
  const url = new URL(endpoint.path, `${current.baseUrl}/`);
  for (const [key, item] of Object.entries(endpoint.query || {})) url.searchParams.set(key, item);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${current.token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(current.timeout),
      });
    } catch (error) {
      if (attempt < 2) { await pause(250 * (attempt + 1)); continue; }
      throw badRequest(`Compass ${name} request could not be completed.`, { code: 'COMPASS_UNAVAILABLE', cause: error.message });
    }

    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await pause(250 * (attempt + 1));
      continue;
    }
    if (!response.ok) {
      throw badRequest(`Compass ${name} request returned HTTP ${response.status}.`, {
        code: response.status === 401 || response.status === 403 ? 'COMPASS_AUTH_FAILED' : 'COMPASS_REQUEST_FAILED',
        status: response.status,
      });
    }
    let body;
    try { body = await response.json(); } catch { throw badRequest(`Compass ${name} response was not valid JSON.`, { code: 'COMPASS_INVALID_RESPONSE' }); }
    if (!Array.isArray(body?.[endpoint.key])) {
      throw badRequest(`Compass ${name} response did not contain ${endpoint.key}.`, { code: 'COMPASS_INVALID_RESPONSE' });
    }
    return body[endpoint.key];
  }
  throw badRequest(`Compass ${name} request failed.`, { code: 'COMPASS_UNAVAILABLE' });
}

export async function readCompassSnapshot() {
  const [divisions, operators, providers, runCuts] = await Promise.all([
    getCollection('divisions'),
    getCollection('operators'),
    getCollection('providers'),
    getCollection('runCuts'),
  ]);
  return { divisions, operators, providers, runCuts, retrievedAt: new Date() };
}

export async function testCompassConnection() {
  const snapshot = await readCompassSnapshot();
  return {
    connected: true,
    retrievedAt: snapshot.retrievedAt,
    counts: {
      divisions: snapshot.divisions.length,
      providers: snapshot.providers.length,
      operators: snapshot.operators.length,
      runCuts: snapshot.runCuts.length,
    },
  };
}
