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
  t.after(async () => {
    try {
      if (created) await query(`DROP TABLE IF EXISTS ${sessions}; DROP TABLE IF EXISTS ${equipment}; DROP TABLE IF EXISTS ${users}; DROP SCHEMA [${schema}];`);
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
  const logout = await request('/auth/logout', {
    method: 'POST',
    headers: { Cookie: cookie(member), 'X-CSRF-Token': memberUser.csrf_token },
  });
  assert.equal(logout.status, 204);
  assert.equal((await query(`SELECT 1 AS present FROM ${sessions}`)).recordset.length, 1);
  await expectError(await request('/equipment', { headers: { Cookie: cookie(member) } }), 401, 'AUTH_REQUIRED');
  await query(`UPDATE ${sessions} SET expires_at = DATEADD(second, -1, SYSUTCDATETIME())`);
  await expectError(await request('/equipment', { headers: { Cookie: cookie(manager) } }), 401, 'AUTH_REQUIRED');
  await sqlServerStore(pool, sql, schema).deleteExpiredSessions();
  assert.equal((await query(`SELECT 1 AS present FROM ${sessions}`)).recordset.length, 0);
});
