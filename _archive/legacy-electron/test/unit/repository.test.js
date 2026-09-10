const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { JsonRepository } = require('../../repositories/json-repository');

function tempRepository() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-workbench-repo-'));
  const repository = new JsonRepository(dataDir);
  return { dataDir, repository };
}

test('空库读取会补齐所有集合和角色设置', (t) => {
  const { dataDir, repository } = tempRepository();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  assert.deepEqual(repository.read(), {
    tasks: [], todos: [], notes: [], files: [], settings: { assistants: [], viewers: [] }
  });
});

test('旧 JSON 会被规范化但保留已有业务数据', (t) => {
  const { dataDir, repository } = tempRepository();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'workbench.json'), JSON.stringify({ tasks: [{ id: 'legacy' }], settings: {} }));
  const db = repository.read();
  assert.equal(db.tasks[0].id, 'legacy');
  assert.deepEqual(db.todos, []);
  assert.deepEqual(db.notes, []);
  assert.deepEqual(db.files, []);
  assert.deepEqual(db.settings.assistants, []);
  assert.deepEqual(db.settings.viewers, []);
});

test('写入后可重新读取，临时文件不会残留', async (t) => {
  const { dataDir, repository } = tempRepository();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const db = { tasks: [{ id: 'atomic', title: '原子写入' }], settings: { assistants: [], viewers: [] } };
  await repository.write(db);
  assert.deepEqual(repository.read().tasks, db.tasks);
  assert.equal(fs.existsSync(path.join(dataDir, 'workbench.json.tmp')), false);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dataDir, 'workbench.json'), 'utf8')));
});

test('第二次写入会自动生成备份，并最多保留五份', async (t) => {
  const { dataDir, repository } = tempRepository();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  await repository.write({ tasks: [{ id: 'v1' }], settings: {} });
  await repository.write({ tasks: [{ id: 'v2' }], settings: {} });
  assert.ok(fs.readdirSync(dataDir).some((name) => name.endsWith('.json.bak')));
  for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(dataDir, `manual-${i}.json.bak`), '{}');
  await repository.write({ tasks: [{ id: 'v3' }], settings: {} });
  const backups = fs.readdirSync(dataDir).filter((name) => name.endsWith('.json.bak'));
  assert.ok(backups.length <= 5, `backup count was ${backups.length}`);
});

test('API token 生成后可持久化', async (t) => {
  const { dataDir, repository } = tempRepository();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const token = await repository.ensureApiToken();
  assert.match(token, /^[a-f0-9]{32}$/);
  assert.equal(repository.read().settings.apiToken, token);
});
