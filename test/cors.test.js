import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

const originalClientOrigin = process.env.CLIENT_ORIGIN;

after(() => {
  if (originalClientOrigin === undefined) delete process.env.CLIENT_ORIGIN;
  else process.env.CLIENT_ORIGIN = originalClientOrigin;
});

async function withServer(run) {
  const server = createApp().listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('allows the deployed Render client origin', async () => {
  delete process.env.CLIENT_ORIGIN;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/divisions`, {
      headers: { Origin: 'https://vdpmanagementf.onrender.com' },
    });

    assert.equal(response.headers.get('access-control-allow-origin'), 'https://vdpmanagementf.onrender.com');
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  });
});

test('allows credentialed preflight requests from the deployed Render client', async () => {
  delete process.env.CLIENT_ORIGIN;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://vdpmanagementf.onrender.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://vdpmanagementf.onrender.com');
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    assert.match(response.headers.get('access-control-allow-methods'), /POST/);
  });
});

test('keeps comma-separated CLIENT_ORIGIN entries in the allowlist', async () => {
  process.env.CLIENT_ORIGIN = 'https://admin.example.com/, https://reports.example.com';
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/divisions`, {
      headers: { Origin: 'https://admin.example.com' },
    });

    assert.equal(response.headers.get('access-control-allow-origin'), 'https://admin.example.com');
  });
});

test('does not add CORS headers for an unknown origin', async () => {
  delete process.env.CLIENT_ORIGIN;
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/divisions`, {
      headers: { Origin: 'https://untrusted.example.com' },
    });

    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });
});
