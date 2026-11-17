import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { hashPassword } from '../password.js';
import { cookie, expectError, login, origin, serve } from './helpers.js';

test('availability validates input after authorization and maps store results', async (t) => {
  let role = 'MEMBER';
  let fail = false;
  let reads = 0;
  const from = '2026-11-16T02:00:00.123Z';
  const to = '2026-11-17T06:00:00.000Z';
  const store = {
    userBySession: () => ({ id: 1, username: 'demo.member', role }),
    readAvailability(id, start, end) {
      reads++;
      assert.equal(start.toISOString(), from);
      assert.equal(end.toISOString(), to);
      if (fail) throw new Error('Synthetic database failure');
      return id === 1 ? [
        { start_at: new Date('2026-11-15T01:00:00Z'), end_at: new Date('2026-11-16T03:00:00Z') },
        { start_at: new Date('2026-11-16T03:00:00Z'), end_at: new Date('2026-11-16T04:00:00.456Z') },
      ] : [];
    },
  };
  const request = await serve(t, await createApp({ store, origin, logger: { error() {} } }));
  const headers = { Cookie: '__Host-lending_session=' + randomBytes(32).toString('base64url') };
  const path = '/equipment/1/availability';
  const query = '?from=' + from + '&to=' + to;
  await expectError(await request(path), 401, 'AUTH_REQUIRED');
  role = 'OTHER';
  await expectError(await request(path, { headers }), 403, 'FORBIDDEN');
  role = 'MEMBER';
  for (const invalid of [
    path, path + '?from=' + from, path + query + '&from=' + from,
    '/equipment/2147483648/availability' + query, '/equipment/1.5/availability' + query,
    ...['2026-02-29T02:00:00Z', '2026-11-16T24:00:00Z', '2026-11-16T02:00:00',
      '0001-01-01T00:00:00%2B07:00', '2026-11-16T02:00:00.0001Z', to, '2026-11-18T00:00:00Z']
      .map(value => path + '?from=' + value + '&to=' + to),
  ]) {
    await expectError(await request(invalid, { headers }), 400, 'INVALID_INPUT');
  }
  assert.equal(reads, 0);
  await expectError(await request('/equipment/2/availability' + query, { headers }), 404, 'NOT_FOUND');
  const response = await request(path + '?from=2026-11-16T09:00:00.123%2B07:00&to=' + to, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(new Date(body.as_of).toISOString(), body.as_of);
  assert.deepEqual(body, {
    equipment_id: 1,
    timezone: 'Asia/Bangkok',
    as_of: body.as_of,
    available: [{ start_at: '2026-11-16T04:00:00.456Z', end_at: to }],
  });
  fail = true;
  await expectError(await request(path + query, { headers }), 500, 'INTERNAL_ERROR');
});

test('HTTP session, role checks, CSRF, expiry, revocation and login throttling', async (t) => {
  const password = 'synthetic-test-password';
  const password_hash = await hashPassword(password);
  const users = [
    { id: 1, username: 'demo.member', role: 'MEMBER', password_hash },
    { id: 2, username: 'demo.manager', role: 'MANAGER', password_hash },
  ];
  const equipment = [
    { id: 1, asset_code: 'DEMO-01', name: 'Máy chiếu' },
    { id: 2, asset_code: 'DEMO-02', name: 'Máy chiếu' },
  ];
  const sessions = new Map();
  const loan = { id: 12, equipment_id: 1, status: 'PENDING' };
  const otherLoan = { id: 15, equipment_id: 2, status: 'PENDING' };
  const store = {
    userByUsername: (username) => users.find((user) => user.username === username),
    createSession: (hash, id) => sessions.set(hash.toString('hex'), { id, expired: false }),
    userBySession(hash) {
      const session = sessions.get(hash.toString('hex'));
      return session && !session.expired ? users.find((user) => user.id === session.id) : undefined;
    },
    deleteSession: (hash) => sessions.delete(hash.toString('hex')),
    listEquipment: () => equipment,
    createLoanRequest(borrowerId, { equipmentId, start, end }) {
      assert.equal(borrowerId, 1);
      if (equipmentId !== 1) return;
      return Object.assign(loan, { start_at: start, end_at: end, created_at: new Date(0) });
    },
    listLoanRequests: borrowerId => borrowerId === 1 ? [loan] : [otherLoan],
    readLoanRequest: (borrowerId, id) => borrowerId === 1 && id === loan.id ? loan : undefined,
  };
  let executions = 0;
  const action = '/test/manage/999';
  const routes = new Map([['POST ' + action, {
    role: 'MANAGER',
    handle(_req, res) {
      executions++;
      res.writeHead(204).end();
    },
  }]]);
  let time = 0;
  const request = await serve(t, await createApp({ store, routes, origin, now: () => time }));

  await expectError(await request('/equipment'), 401, 'AUTH_REQUIRED');
  await expectError(await request(action, { method: 'POST' }), 401, 'AUTH_REQUIRED');
  await expectError(await login(request, 'demo.member', password, 'https://other.example.test'), 403, 'ORIGIN_FORBIDDEN');
  await expectError(await login(request, 'demo.member', ''), 400, 'INVALID_INPUT');
  await expectError(await login(request, 'unknown', password), 401, 'INVALID_CREDENTIALS');
  await expectError(await login(request, 'demo.member', 'wrong'), 401, 'INVALID_CREDENTIALS');

  const headers = [];
  for (const { id, username, role } of users) {
    const response = await login(request, username, password);
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie');
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=28800']) {
      assert.ok(setCookie.split('; ').includes(attr));
    }
    const user = await response.json();
    assert.deepEqual(Object.keys(user).sort(), ['csrf_token', 'id', 'role', 'username']);
    assert.deepEqual(user, { id, username, role, csrf_token: user.csrf_token });
    assert.match(user.csrf_token, /^[A-Za-z0-9_-]{43}$/);
    const sessionHeaders = { Cookie: cookie(response), 'X-CSRF-Token': user.csrf_token };
    headers.push(sessionHeaders);
    assert.deepEqual(await (await request('/auth/me', { headers: sessionHeaders })).json(), user);
    assert.deepEqual(await (await request('/equipment', { headers: sessionHeaders })).json(), equipment);
  }
  const [member, manager] = headers;
  await expectError(await request(action, { method: 'POST', headers: member }), 403, 'FORBIDDEN');
  await expectError(await request(action, {
    method: 'POST', headers: { ...manager, 'X-CSRF-Token': member['X-CSRF-Token'] },
  }), 403, 'CSRF_INVALID');
  assert.equal(executions, 0);
  assert.equal((await request(action, { method: 'POST', headers: manager })).status, 204);
  assert.equal(executions, 1);

  const loanPath = '/loan-requests';
  const validLoan = {
    equipment_id: 1,
    start_at: '2026-11-16T23:30:00+07:00',
    end_at: '2026-11-17T00:30:00+07:00',
  };
  const post = (headers, body = validLoan) => request(loanPath, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await expectError(await post({}), 401, 'AUTH_REQUIRED');
  await expectError(await request(loanPath), 401, 'AUTH_REQUIRED');
  await expectError(await request(loanPath, { headers: manager }), 403, 'FORBIDDEN');
  await expectError(await post(manager), 403, 'FORBIDDEN');
  await expectError(await request(loanPath + '/1', { headers: manager }), 403, 'FORBIDDEN');
  await expectError(await post({ Cookie: member.Cookie }), 403, 'CSRF_INVALID');
  await expectError(await post({ ...member, 'X-CSRF-Token': manager['X-CSRF-Token'] }), 403, 'CSRF_INVALID');
  for (const invalid of [
    {}, { ...validLoan, borrower_id: 2 }, { ...validLoan, status: 'APPROVED' },
    { ...validLoan, equipment_id: '1' }, { ...validLoan, equipment_id: 2147483648 },
    { ...validLoan, start_at: '2026-02-29T23:30:00+07:00' },
    { ...validLoan, start_at: '2026-11-16T23:30:00' },
    { ...validLoan, start_at: '0001-01-01T00:00:00+07:00' },
    { ...validLoan, end_at: '2026-11-16T16:30:00Z' },
    { ...validLoan, end_at: '2026-11-16T16:00:00Z' },
  ]) {
    await expectError(await post(member, invalid), 400, 'INVALID_INPUT');
  }
  await expectError(await request(loanPath + '/2147483648', { headers: member }), 400, 'INVALID_INPUT');
  await expectError(await post(member, { ...validLoan, equipment_id: 99 }), 404, 'NOT_FOUND');
  const created = await post(member);
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('location'), loanPath + '/12');
  const saved = await created.json();
  assert.deepEqual(saved, {
    id: 12, equipment_id: 1, start_at: '2026-11-16T16:30:00.000Z',
    end_at: '2026-11-16T17:30:00.000Z', created_at: '1970-01-01T00:00:00.000Z', status: 'PENDING',
  });
  assert.deepEqual(await (await request(loanPath, { headers: member })).json(), [saved]);
  const detail = await request(loanPath + '/12', { headers: member });
  assert.equal(detail.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await detail.json(), saved);
  await expectError(await request(loanPath + '/15', { headers: member }), 404, 'NOT_FOUND');
  await expectError(await request(loanPath + '/99', { headers: member }), 404, 'NOT_FOUND');

  const logout = await request('/auth/logout', { method: 'POST', headers: manager });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  await expectError(await request('/equipment', { headers: manager }), 401, 'AUTH_REQUIRED');
  for (const session of sessions.values()) session.expired = true;
  await expectError(await request('/equipment', { headers: member }), 401, 'AUTH_REQUIRED');

  for (let attempt = 0; attempt < 5; attempt++) {
    await expectError(await login(request, 'demo.member', ''), 400, 'INVALID_INPUT');
  }
  const limited = await login((path, options) => request(path, {
    ...options,
    headers: { ...options.headers, 'X-Lending-Client-IP': '192.0.2.10' },
  }), 'demo.member', password);
  assert.equal(limited.headers.get('retry-after'), '60');
  await expectError(limited, 429, 'LOGIN_RATE_LIMITED');
  time += 60_000;
  assert.equal((await login(request, 'demo.member', password)).status, 200);
});

test('clients sharing a trusted proxy have separate login limits', async (t) => {
  const password = 'synthetic-test-password';
  const manager = {
    id: 2,
    username: 'demo.manager',
    role: 'MANAGER',
    password_hash: await hashPassword(password),
  };
  const store = {
    userByUsername: (username) => username === manager.username ? manager : undefined,
    createSession() {},
  };
  const request = await serve(t, await createApp({
    store, origin, trustedProxyIp: '127.0.0.1', now: () => 0,
  }));
  const throughProxy = (address) => (path, options) => request(path, {
    ...options,
    headers: { ...options.headers, 'X-Lending-Client-IP': address },
  });
  const managerClient = throughProxy('2001:db8::10');
  const otherClient = throughProxy('192.0.2.20');

  assert.equal((await login(managerClient, manager.username, password)).status, 200);
  for (let attempt = 0; attempt < 9; attempt++) {
    await expectError(await login(otherClient, manager.username, 'wrong'), 401, 'INVALID_CREDENTIALS');
  }
  assert.equal((await login(managerClient, manager.username, password)).status, 200);
  await expectError(await login(otherClient, manager.username, 'wrong'), 401, 'INVALID_CREDENTIALS');
  const limited = await login(otherClient, manager.username, password);
  assert.equal(limited.headers.get('retry-after'), '60');
  await expectError(limited, 429, 'LOGIN_RATE_LIMITED');
  assert.equal((await login(managerClient, manager.username, password)).status, 200);
});
