const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');

const rootDir = path.resolve(__dirname, '..');

async function findAvailablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function startApplication(port, dataDir, overrides = {}) {
  const child = spawn(process.execPath, ['app.js'], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      SESSION_SECRET: 'test-session-secret-with-more-than-32-characters',
      DEMO_ADMIN_USERNAME: 'test-admin',
      DEMO_ADMIN_PASSWORD: 'test-admin-password-12',
      DEMO_OWNER_USERNAME: 'test-owner',
      DEMO_OWNER_PASSWORD: 'test-owner-password-12',
      DB_PATH: path.join(dataDir, 'apms.db'),
      UPLOADS_DIR: path.join(dataDir, 'uploads'),
      SEED_DEMO_EMPLOYEES: 'false',
      ...overrides
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderrLog = '';
  child.stderr.on('data', (chunk) => { child.stderrLog += chunk.toString(); });
  return child;
}

async function waitForApplication(child, url) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Application exited early: ${lastError || 'no startup response'}`);
    }
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error.message;
    }
    await delay(100);
  }
  throw new Error(`Application did not become ready: ${lastError || 'startup timeout'}`);
}

async function stopApplication(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });
}

async function waitForExit(child) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

function getCookie(response) {
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie, 'expected a session cookie');
  return cookie.split(';', 1)[0];
}

function getCsrfToken(html) {
  const match = html.match(/name="_csrf" value="([a-f0-9]+)"/);
  assert.ok(match, 'expected a CSRF token in the form');
  return match[1];
}

test('protects login, forms, sessions, and uploaded evidence', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apms-security-test-'));
  const port = await findAvailablePort();
  const url = `http://127.0.0.1:${port}`;
  let child = startApplication(port, dataDir);

  t.after(async () => {
    await stopApplication(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForApplication(child, url);
  const loginPage = await fetch(`${url}/login`);
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(loginPage.headers.get('set-cookie'), /HttpOnly/i);

  const initialCookie = getCookie(loginPage);
  const loginHtml = await loginPage.text();
  const loginToken = getCsrfToken(loginHtml);
  const csrfRejected = await fetch(`${url}/settings/password`, {
    method: 'POST',
    headers: { Cookie: initialCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'new_password=not-authorized'
  });
  assert.equal(csrfRejected.status, 403);

  const loginResponse = await fetch(`${url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: initialCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'test-admin', password: 'test-admin-password-12', _csrf: loginToken })
  });
  assert.equal(loginResponse.status, 302);
  assert.equal(loginResponse.headers.get('location'), '/dashboard');
  const authenticatedCookie = getCookie(loginResponse);
  assert.notEqual(authenticatedCookie, initialCookie, 'login should rotate the session identifier');

  const dashboard = await fetch(`${url}/dashboard`, { headers: { Cookie: authenticatedCookie } });
  assert.equal(dashboard.status, 200);
  const blockedMutation = await fetch(`${url}/jobdesk/save`, {
    method: 'POST',
    headers: { Cookie: authenticatedCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'name=blocked'
  });
  assert.equal(blockedMutation.status, 403);

  const auditPage = await fetch(`${url}/audit`, { headers: { Cookie: authenticatedCookie } });
  assert.equal(auditPage.status, 200);
  const auditToken = getCsrfToken(await auditPage.text());
  const invalidFileForm = new FormData();
  invalidFileForm.set('_csrf', auditToken);
  invalidFileForm.set('evidence', new Blob(['not an image']), 'payload.txt');
  const invalidUpload = await fetch(`${url}/audit/save`, {
    method: 'POST',
    headers: { Cookie: authenticatedCookie },
    body: invalidFileForm
  });
  assert.equal(invalidUpload.status, 415);
  assert.equal(fs.readdirSync(path.join(dataDir, 'uploads')).length, 0);

  const csrfRejectedUpload = new FormData();
  csrfRejectedUpload.set('_csrf', 'invalid-token');
  csrfRejectedUpload.set('admin_id', '1');
  csrfRejectedUpload.set('audit_date', '2026-11-03');
  csrfRejectedUpload.set('task_name', 'Rejected upload test');
  csrfRejectedUpload.set('jobdesk_id', '');
  csrfRejectedUpload.set('inspection_result', '');
  csrfRejectedUpload.set('sop_match', 'Sesuai');
  csrfRejectedUpload.set('findings', '');
  csrfRejectedUpload.set('recommendation', '');
  csrfRejectedUpload.set('auditor', 'Test owner');
  csrfRejectedUpload.set('follow_up_status', 'Menunggu Pemeriksaan');
  csrfRejectedUpload.set('evidence', new Blob(['%PDF-1.4 rejected'], { type: 'application/pdf' }), 'rejected.pdf');
  const csrfUploadResponse = await fetch(`${url}/audit/save`, {
    method: 'POST',
    headers: { Cookie: authenticatedCookie },
    body: csrfRejectedUpload
  });
  assert.equal(csrfUploadResponse.status, 403);
  assert.equal(fs.readdirSync(path.join(dataDir, 'uploads')).length, 0, 'CSRF-rejected files should be removed');

  const validFileForm = new FormData();
  validFileForm.set('_csrf', auditToken);
  validFileForm.set('admin_id', '1');
  validFileForm.set('jobdesk_id', '');
  validFileForm.set('audit_date', '2026-11-03');
  validFileForm.set('task_name', 'Upload security test');
  validFileForm.set('inspection_result', '');
  validFileForm.set('sop_match', 'Sesuai');
  validFileForm.set('findings', '');
  validFileForm.set('recommendation', '');
  validFileForm.set('auditor', 'Test owner');
  validFileForm.set('follow_up_status', 'Menunggu Pemeriksaan');
  validFileForm.set('evidence', new Blob(['%PDF-1.4 test evidence'], { type: 'application/pdf' }), 'evidence.pdf');
  const validUpload = await fetch(`${url}/audit/save`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: authenticatedCookie },
    body: validFileForm
  });
  assert.equal(validUpload.status, 302, `${await validUpload.text()}\n${child.stderrLog}`);
  const uploadedName = fs.readdirSync(path.join(dataDir, 'uploads'))[0];
  assert.match(uploadedName, /^[0-9a-f-]{36}\.pdf$/i);
  const privateFile = await fetch(`${url}/uploads/${uploadedName}`, { redirect: 'manual' });
  assert.equal(privateFile.status, 302);
  const evidence = await fetch(`${url}/uploads/${uploadedName}`, { headers: { Cookie: authenticatedCookie } });
  assert.equal(evidence.status, 200);
  assert.equal(evidence.headers.get('content-type'), 'application/pdf');

  const secondLoginPage = await fetch(`${url}/login`);
  const secondLoginCookie = getCookie(secondLoginPage);
  const secondLoginToken = getCsrfToken(await secondLoginPage.text());
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const failedLogin = await fetch(`${url}/login`, {
      method: 'POST',
      headers: { Cookie: secondLoginCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'test-admin', password: 'wrong-password', _csrf: secondLoginToken })
    });
    assert.equal(failedLogin.status, 401);
  }
  const limitedLogin = await fetch(`${url}/login`, {
    method: 'POST',
    headers: { Cookie: secondLoginCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'test-admin', password: 'wrong-password', _csrf: secondLoginToken })
  });
  assert.equal(limitedLogin.status, 429);

  await stopApplication(child);
  child = startApplication(port, dataDir);
  await waitForApplication(child, url);
  const restoredSession = await fetch(`${url}/dashboard`, { headers: { Cookie: authenticatedCookie } });
  assert.equal(restoredSession.status, 200, 'the session should survive an application restart');

  const health = await fetch(`${url}/health`);
  assert.deepEqual(await health.json(), { status: 'ok' });
});

test('requires production secrets and sends secure session cookies', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apms-production-test-'));
  const port = await findAvailablePort();
  const url = `http://127.0.0.1:${port}`;
  let child = startApplication(port, dataDir, {
    NODE_ENV: 'production',
    TRUST_PROXY: '1',
    SESSION_SECRET: 'production-session-secret-with-more-than-32-characters',
    DEMO_ADMIN_USERNAME: 'operations-admin',
    DEMO_ADMIN_PASSWORD: 'unique-admin-password-12',
    DEMO_OWNER_USERNAME: 'system-owner',
    DEMO_OWNER_PASSWORD: 'unique-owner-password-12'
  });

  t.after(async () => {
    await stopApplication(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForApplication(child, url);
  const response = await fetch(`${url}/login`, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /Secure/i);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/i);
  await stopApplication(child);

  child = startApplication(port, dataDir, {
    NODE_ENV: 'production',
    SESSION_SECRET: 'replace-with-example-secret-that-is-too-predictable',
    DEMO_ADMIN_USERNAME: 'operations-admin',
    DEMO_ADMIN_PASSWORD: 'unique-admin-password-12',
    DEMO_OWNER_USERNAME: 'system-owner',
    DEMO_OWNER_PASSWORD: 'unique-owner-password-12'
  });
  assert.notEqual(await waitForExit(child), 0);
  assert.match(child.stderrLog, /Production requires SESSION_SECRET/);
});
