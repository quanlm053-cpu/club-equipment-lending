import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { connectDatabase, migrate, sqlServerStore, seedDemo } from '../database.js';
import { cookie, expectError, login, origin, serve } from './helpers.js';

test('SQL Server migration, repeatable demo seed and session lifecycle through HTTP', async (t) => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString, 'Set TEST_DATABASE_URL to a disposable SQL Server database');
  const schema = 'lending_test_' + randomBytes(8).toString('hex');
  const { pool, sql } = await connectDatabase({ ...process.env, DATABASE_URL: connectionString });
  const query = statement => pool.request().query(statement);
  const users = `[${schema}].[users]`;
  const sessions = `[${schema}].[sessions]`;
  const equipment = `[${schema}].[equipment]`;
  const loans = `[${schema}].[loan_requests]`;
  t.after(async () => {
    try {
      if (created) await query(`DROP TABLE IF EXISTS ${loans}; DROP TABLE IF EXISTS ${sessions}; DROP TABLE IF EXISTS ${equipment}; DROP TABLE IF EXISTS ${users}; DROP SCHEMA [${schema}];`);
    } finally {
      await pool.close();
    }
  });
  let created = false;
  const db = (await query('SELECT DB_NAME() AS name')).recordset[0].name;
  assert.equal(db, 'ClubEquipmentLending_Test', 'Use the isolated Lending test database');
  await query(`CREATE SCHEMA [${schema}]`);
  created = true;
  await migrate(pool, sql, schema);
  await migrate(pool, sql, schema);

  const env = {
    LENDING_ENV: 'test',
    DEMO_MEMBER_PASSWORD: 'synthetic-member-test',
    DEMO_MANAGER_PASSWORD: 'synthetic-manager-test',
  };
  await assert.rejects(seedDemo(pool, sql, { ...env, LENDING_ENV: 'production' }, schema));
  await seedDemo(pool, sql, env, schema);
  const initial = await query(`SELECT id, username, password_hash, role FROM ${users} ORDER BY username`);
  await seedDemo(pool, sql, env, schema);
  assert.deepEqual((await query(`SELECT id, username, password_hash, role FROM ${users} ORDER BY username`)).recordset, initial.recordset);
  assert.equal(initial.recordset.length, 2);
  assert.ok(initial.recordset.every((row) => row.password_hash.startsWith('$argon2id$')));

  const request = await serve(t, await createApp({ store: sqlServerStore(pool, sql, schema), origin }));
  const member = await login(request, 'demo.member', env.DEMO_MEMBER_PASSWORD);
  const manager = await login(request, 'demo.manager', env.DEMO_MANAGER_PASSWORD);
  for (const [response, role] of [[member, 'MEMBER'], [manager, 'MANAGER']]) {
    assert.equal(response.status, 200);
    const headers = { Cookie: cookie(response) };
    const me = await request('/auth/me', { headers });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).role, role);
    const list = await request('/equipment', { headers });
    assert.equal(list.status, 200);
    const items = await list.json();
    assert.deepEqual(items.map((item) => item.asset_code), ['DEMO-01', 'DEMO-02']);
    assert.notEqual(items[0].id, items[1].id);
    assert.equal(items[0].name, items[1].name);
  }

  const memberUser = await member.json();
  await query(`
    INSERT INTO ${loans} (equipment_id, borrower_id, start_at, end_at, status)
    SELECT e.id, u.id, fixture.start_at, fixture.end_at, fixture.status
    FROM ${equipment} e CROSS JOIN ${users} u CROSS JOIN (VALUES
      ('2026-11-16T01:30:00', '2026-11-16T03:00:00', 'APPROVED'),
      ('2026-11-16T03:00:00', '2026-11-16T04:00:00', 'HANDED_OVER'),
      ('2026-11-16T00:00:00', '2026-11-16T02:00:00', 'APPROVED'),
      ('2026-11-16T06:00:00', '2026-11-16T07:00:00', 'APPROVED'),
      ('2026-11-16T04:00:00', '2026-11-16T04:30:00', 'PENDING'),
      ('2026-11-16T04:30:00', '2026-11-16T05:00:00', 'REJECTED'),
      ('2026-11-16T05:00:00', '2026-11-16T06:00:00', 'RETURNED')
    ) fixture(start_at, end_at, status)
    WHERE e.asset_code = 'DEMO-01' AND u.username = 'demo.member';
  `);
  const [first, second] = await sqlServerStore(pool, sql, schema).listEquipment();
  const at = (time) => `2026-11-16T${time}:00.000Z`;
  async function expectSlots(id, from, to, expected, response = member) {
    const query = new URLSearchParams({ from, to });
    const result = await request(`/equipment/${id}/availability?${query}`, {
      headers: { Cookie: cookie(response) },
    });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    const body = await result.json();
    assert.equal(new Date(body.as_of).toISOString(), body.as_of);
    assert.deepEqual(body, {
      equipment_id: id,
      timezone: 'Asia/Bangkok',
      as_of: body.as_of,
      available: expected.map(([start_at, end_at]) => ({ start_at, end_at })),
    });
  }
  await expectSlots(first.id, '2026-11-16T09:00:00+07:00', '2026-11-16T13:00:00+07:00',
    [[at('04:00'), at('06:00')]]);
  await expectSlots(first.id, at('02:00'), at('06:00'), [[at('04:00'), at('06:00')]], manager);
  await expectSlots(first.id, at('02:00'), at('04:00'), []);
  await expectSlots(first.id, '2026-11-15T23:00:00.123Z', at('08:00'),
    [['2026-11-15T23:00:00.123Z', at('00:00')], [at('04:00'), at('06:00')], [at('07:00'), at('08:00')]]);
  await expectSlots(second.id, at('02:00'), at('06:00'), [[at('02:00'), at('06:00')]]);
  await query(`UPDATE ${loans} SET status = 'RETURNED' WHERE status = 'HANDED_OVER'`);
  await expectSlots(first.id, at('02:00'), at('06:00'), [[at('03:00'), at('06:00')]]);

  const logout = await request('/auth/logout', {
    method: 'POST',
    headers: { Cookie: cookie(member), 'X-CSRF-Token': memberUser.csrf_token },
  });
  assert.equal(logout.status, 204);
  assert.equal((await query(`SELECT 1 AS present FROM ${sessions}`)).recordset.length, 1);
  await expectError(await request('/equipment', { headers: { Cookie: cookie(member) } }), 401, 'AUTH_REQUIRED');
  await query(`UPDATE ${sessions} SET expires_at = DATEADD(second, -1, SYSUTCDATETIME())`);
  await expectError(await request('/equipment', { headers: { Cookie: cookie(manager) } }), 401, 'AUTH_REQUIRED');
  await expectError(await request(`/equipment/${first.id}/availability?from=${at('02:00')}&to=${at('06:00')}`, {
    headers: { Cookie: cookie(manager) },
  }), 401, 'AUTH_REQUIRED');
  await sqlServerStore(pool, sql, schema).deleteExpiredSessions();
  assert.equal((await query(`SELECT 1 AS present FROM ${sessions}`)).recordset.length, 0);
});
