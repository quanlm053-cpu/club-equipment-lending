const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const source = readFileSync(require.resolve('../app.js'), 'utf8')
  .replace(/void checkSession\(\);\s*$/, '');
const manager = { id: 1, role: 'MANAGER', csrf_token: 'demo-token' };
const pending = { id: 42, status: 'PENDING' };

function setup() {
  const nodes = new Map();
  const requests = [];
  const app = runInNewContext(source + `
    user = initialSession;
    ({ checkSession, logout, submitDecision, managementBusy, managementDecisions, getUser: () => user });
  `, {
    initialSession: { ...manager },
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, {
          addEventListener() {},
          close() {},
          focus() {},
          replaceChildren() {},
          reset() {},
          removeAttribute() {},
          setAttribute() {},
          classList: { toggle() {} },
        });
        return nodes.get(id);
      },
      querySelectorAll: () => [],
    },
    window: { addEventListener() {} },
    location: { hash: '#equipment' },
    history: { replaceState() {} },
    AbortController,
    AbortSignal,
    fetch(path, options) {
      if (path === '/equipment') return Promise.resolve(Response.json([]));
      const { promise, resolve, reject } = Promise.withResolvers();
      requests.push({ path, method: options.method ?? 'GET', resolve, reject });
      return promise;
    },
  });
  return {
    ...app,
    take(path, method = 'GET') {
      const request = requests.shift();
      assert.equal(request?.path, path);
      assert.equal(request.method, method);
      return request;
    },
    requests,
  };
}

const flush = () => new Promise(setImmediate);

for (const [verb, status] of [['approve', 'APPROVED'], ['reject', 'REJECTED']]) {
  test(`${verb} releases the queue after the same session is verified`, async () => {
    const app = setup();
    const session = app.getUser();
    const submitting = app.submitDecision({ item: pending, verb, user: session });
    const post = app.take('/loan-requests/42/' + verb, 'POST');
    const checking = app.checkSession();
    post.resolve(Response.json({ status }));
    await flush();
    assert.equal(app.managementBusy(), true);
    app.take('/auth/me').resolve(Response.json(manager));
    await Promise.all([checking, submitting]);
    assert.equal(app.getUser(), session);
    assert.equal(app.managementBusy(), false);
    assert.equal(app.managementDecisions.has(42), false);
  });
}

test('a conflict reconciles after retrying a failed session check', async () => {
  const app = setup();
  const session = app.getUser();
  const submitting = app.submitDecision({ item: pending, verb: 'approve', user: session });
  const post = app.take('/loan-requests/42/approve', 'POST');
  const checking = app.checkSession();
  app.take('/auth/me').reject(new TypeError('demo network error'));
  await checking;
  post.resolve(Response.json({ code: 'SCHEDULE_CONFLICT' }, { status: 409 }));
  await flush();
  assert.equal(app.requests.length, 0);
  const retrying = app.checkSession();
  app.take('/auth/me').resolve(Response.json(manager));
  await retrying;
  await flush();
  app.take('/loan-requests/42').resolve(Response.json(pending));
  await flush();
  app.take('/loan-requests').resolve(Response.json([pending]));
  await submitting;
  assert.equal(app.getUser(), session);
  assert.equal(app.managementBusy(), false);
  assert.equal(app.managementDecisions.get(42).locked, false);
});

test('an old decision cannot reconcile in a replacement session', async () => {
  const app = setup();
  const session = app.getUser();
  const submitting = app.submitDecision({ item: pending, verb: 'reject', user: session });
  const post = app.take('/loan-requests/42/reject', 'POST');
  const checking = app.checkSession();
  post.reject(new TypeError('demo network error'));
  await flush();
  app.take('/auth/me').resolve(Response.json({ ...manager, csrf_token: 'replacement-token' }));
  await Promise.all([checking, submitting]);
  assert.notEqual(app.getUser(), session);
  assert.equal(app.requests.length, 0);
  assert.equal(app.managementBusy(), false);
  assert.equal(app.managementDecisions.size, 0);
});

test('logout CSRF recovery clears decisions from the replaced session', async () => {
  const app = setup();
  const session = app.getUser();
  const submitting = app.submitDecision({ item: pending, verb: 'approve', user: session });
  const post = app.take('/loan-requests/42/approve', 'POST');
  assert.equal(app.managementBusy(), true);

  const loggingOut = app.logout();
  app.take('/auth/logout', 'POST').resolve(Response.json({ code: 'CSRF_INVALID' }, { status: 403 }));
  await flush();
  const replacement = { ...manager, csrf_token: 'replacement-token' };
  app.take('/auth/me').resolve(Response.json(replacement));
  await loggingOut;

  post.resolve(Response.json({ status: 'APPROVED' }));
  await submitting;
  assert.notEqual(app.getUser(), session);
  assert.equal(app.getUser().csrf_token, replacement.csrf_token);
  assert.equal(app.managementBusy(), false);
  assert.equal(app.managementDecisions.size, 0);
  assert.equal(app.requests.length, 0);
});
