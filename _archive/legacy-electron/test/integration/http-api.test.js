const test = require('node:test');
const assert = require('node:assert/strict');
const { apiRequest, makeDb, rawRequest, startHttpFixture, stopHttpFixture } = require('../helpers/harness');

let fixture;

test.before(async () => { fixture = await startHttpFixture(); });
test.after(async () => { await stopHttpFixture(fixture); });
test.beforeEach(async () => { await fixture.repository.write(makeDb()); });

test('API-01 /api/ping 成功且不需要 token', async () => {
  const result = await apiRequest(fixture.baseUrl, '/api/ping');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, name: 'personal-workbench' });
});

test('API-02 无 token 不能读取任务', async () => {
  const result = await apiRequest(fixture.baseUrl, '/api/share/tasks');
  assert.equal(result.status, 401);
  assert.equal(result.body.ok, false);
});

test('API-03 assistantA 只能看到自己的任务', async () => {
  const result = await apiRequest(fixture.baseUrl, '/api/share/tasks?token=assistant-a-token');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.tasks.map((task) => task.id), ['task-a']);
});

test('API-04 assistantA 不能操作 assistantB 的任务', async () => {
  const result = await apiRequest(fixture.baseUrl, '/api/share/tasks/task-b/progress', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'assistant-a-token', progress: 50 })
  });
  assert.equal(result.status, 403);
});

test('API-05 assistantA 可以发布且负责人自动绑定本人', async () => {
  const created = await apiRequest(fixture.baseUrl, '/api/share/tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'assistant-a-token', title: '助理新任务', priority: 'P2' })
  });
  assert.equal(created.status, 200);
  const list = await apiRequest(fixture.baseUrl, '/api/share/tasks?token=owner-token');
  const task = list.body.tasks.find((item) => item.title === '助理新任务');
  assert.equal(task.assignee, 'assistant:assistant-a');
});

test('API-06 viewer 不能发布任务或修改进度', async () => {
  const publish = await apiRequest(fixture.baseUrl, '/api/share/tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'viewer-token', title: '不应创建' })
  });
  const progress = await apiRequest(fixture.baseUrl, '/api/share/tasks/task-a/progress', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'viewer-token', progress: 20 })
  });
  assert.equal(publish.status, 403);
  assert.equal(progress.status, 403);
});

test('API-07 viewer 可以评论可见的助理任务', async () => {
  const result = await apiRequest(fixture.baseUrl, '/api/share/tasks/task-a/comment', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'viewer-token', text: '请补充反馈' })
  });
  assert.equal(result.status, 200);
  const ownerView = await apiRequest(fixture.baseUrl, '/api/share/tasks?token=owner-token');
  assert.equal(ownerView.body.tasks.find((task) => task.id === 'task-a').comments[0].text, '请补充反馈');
});

test('API-08 无效 token 返回 401', async () => {
  const result = await apiRequest(fixture.baseUrl, '/api/share/me?token=invalid-token');
  assert.equal(result.status, 401);
});

test('API-09 非法 JSON 返回 400，服务仍可用', async () => {
  const result = await rawRequest(fixture.baseUrl, '/api/share/tasks', {
    body: '{not-json', headers: { 'Content-Type': 'application/json' }
  });
  assert.equal(result.status, 400);
  const ping = await apiRequest(fixture.baseUrl, '/api/ping');
  assert.equal(ping.status, 200);
});

test('API-10 超大请求不会让服务进程崩溃', async () => {
  const result = await rawRequest(fixture.baseUrl, '/api/share/tasks', {
    body: JSON.stringify({ token: 'assistant-a-token', title: 'x'.repeat(1024 * 1024 + 10) }),
    headers: { 'Content-Type': 'application/json' }
  });
  assert.ok(result.status === 413 || result.error, `unexpected result: ${JSON.stringify(result)}`);
  const ping = await apiRequest(fixture.baseUrl, '/api/ping');
  assert.equal(ping.status, 200);
});
