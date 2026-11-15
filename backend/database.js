import { readFile } from 'node:fs/promises';
import { hashPassword } from './password.js';

export const sessionSeconds = 8 * 60 * 60;

export async function connectDatabase(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('Set DATABASE_URL for SQL Server');
  const native = env.SQLSERVER_DRIVER === 'odbc';
  const sql = native
    ? (await import('mssql/msnodesqlv8.js')).default
    : (await import('mssql')).default;
  const pool = await new sql.ConnectionPool(native ? { connectionString: env.DATABASE_URL } : env.DATABASE_URL).connect();
  return { pool, sql };
}

function tables(schema = 'dbo') {
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(schema)) throw new Error('Invalid SQL Server schema');
  return Object.fromEntries(['users', 'sessions', 'equipment'].map(name => [name, `[${schema}].[${name}]`]));
}

export function sqlServerStore(pool, sql, schema) {
  const { users, sessions, equipment } = tables(schema);
  return {
    async userByUsername(username) {
      const result = await pool.request().input('username', sql.NVarChar(255), username)
        .query(`SELECT id, username, role, password_hash FROM ${users} WHERE username = @username`);
      return result.recordset[0];
    },
    async createSession(tokenHash, userId) {
      await pool.request().input('token', sql.Binary(32), tokenHash)
        .input('user', sql.Int, userId).input('seconds', sql.Int, sessionSeconds)
        .query(`INSERT INTO ${sessions} (token_hash, user_id, expires_at)
                VALUES (@token, @user, DATEADD(second, @seconds, SYSUTCDATETIME()))`);
    },
    async userBySession(tokenHash) {
      const result = await pool.request().input('token', sql.Binary(32), tokenHash)
        .query(`SELECT u.id, u.username, u.role FROM ${sessions} s JOIN ${users} u ON u.id = s.user_id
                WHERE s.token_hash = @token AND s.expires_at > SYSUTCDATETIME()`);
      return result.recordset[0];
    },
    async deleteSession(tokenHash) {
      await pool.request().input('token', sql.Binary(32), tokenHash)
        .query(`DELETE FROM ${sessions} WHERE token_hash = @token`);
    },
    async deleteExpiredSessions() {
      await pool.request().query(`DELETE FROM ${sessions} WHERE expires_at <= SYSUTCDATETIME()`);
    },
    async listEquipment() {
      const result = await pool.request().query(`SELECT id, asset_code, name FROM ${equipment} ORDER BY asset_code`);
      return result.recordset;
    },
  };
}

async function transaction(pool, sql, schema, work) {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await tx.request().input('resource', sql.NVarChar(255), 'lending:foundation:' + schema).query(`
      DECLARE @lock int;
      EXEC @lock = sp_getapplock @Resource = @resource, @LockMode = 'Exclusive',
        @LockOwner = 'Transaction', @LockTimeout = 5000;
      IF @lock < 0 THROW 51000, 'Could not lock lending schema', 1;
    `);
    await work(tx);
    await tx.commit();
  } catch (error) {
    await tx.rollback().catch(() => {});
    throw error;
  }
}

export async function migrate(pool, sql, schema = 'dbo') {
  tables(schema);
  const script = await readFile(new URL('./migrations/001-foundation.sql', import.meta.url), 'utf8');
  await transaction(pool, sql, schema, tx => tx.request().batch(script.replaceAll('__SCHEMA__', schema)));
}

export async function seedDemo(pool, sql, env, schema = 'dbo') {
  if (!['demo', 'test'].includes(env.LENDING_ENV)) throw new Error('Seed requires LENDING_ENV=demo or test');
  const { users, equipment } = tables(schema);
  const accounts = [
    ['demo.member', 'MEMBER', env.DEMO_MEMBER_PASSWORD],
    ['demo.manager', 'MANAGER', env.DEMO_MANAGER_PASSWORD],
  ];
  if (accounts.some(([, , password]) => !password || Buffer.byteLength(password) > 1024)) {
    throw new Error('Set both demo passwords to nonempty values of at most 1024 bytes');
  }
  const hashes = await Promise.all(accounts.map(([, , password]) => hashPassword(password)));
  await transaction(pool, sql, schema, async tx => {
    for (const [index, [username, role]] of accounts.entries()) {
      await tx.request().input('username', sql.NVarChar(255), username)
        .input('role', sql.VarChar(16), role).input('hash', sql.VarChar(255), hashes[index])
        .query(`IF NOT EXISTS (SELECT 1 FROM ${users} WHERE username = @username)
                INSERT INTO ${users} (username, role, password_hash) VALUES (@username, @role, @hash)`);
    }
    await tx.request().input('name', sql.NVarChar(255), 'Máy chiếu').query(`
      INSERT INTO ${equipment} (asset_code, name)
      SELECT d.asset_code, @name FROM (VALUES ('DEMO-01'), ('DEMO-02')) d(asset_code)
      WHERE NOT EXISTS (SELECT 1 FROM ${equipment} e WHERE e.asset_code = d.asset_code)`);
  });
}
