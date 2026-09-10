const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');

const { JsonRepository } = require('../../repositories/json-repository');
const { startHttpServer } = require('../../server/http-server');

function makeDb() {
  return {
    tasks: [
      {
        id: 'task-a', title: 'A 的任务', desc: '', priority: 'P1', status: 'todo', progress: 0,
        due: null, assignee: 'assistant:assistant-a', logs: [], source: 'manual', createdAt: 1, doneAt: null
      },
      {
        id: 'task-b', title: 'B 的任务', desc: '', priority: 'P1', status: 'todo', progress: 0,
        due: null, assignee: 'assistant:assistant-b', logs: [], source: 'manual', createdAt: 2, doneAt: null
      },
      {
        id: 'task-owner', title: '主人的私人任务', desc: '', priority: 'P1', status: 'todo', progress: 0,
        due: null, assignee: 'me', logs: [], source: 'manual', createdAt: 3, doneAt: null
      }
    ],
    todos: [],
    notes: [],
    files: [],
    settings: {
      apiToken: 'api-token',
      ownerToken: 'owner-token',
      assistants: [
        { id: 'assistant-a', name: '助理A', token: 'assistant-a-token' },
        { id: 'assistant-b', name: '助理B', token: 'assistant-b-token' }
      ],
      viewers: [{ id: 'viewer-1', name: '查看者', token: 'viewer-token' }]
    }
  };
}

async function startHttpFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-workbench-api-'));
  const repository = new JsonRepository(dataDir);
  await repository.write(makeDb());
  const server = startHttpServer({
    rootDir: path.resolve(__dirname, '../..'),
    repository,
    notifyChanged: () => {},
    port: 0
  });
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { dataDir, repository, server, baseUrl };
}

async function stopHttpFixture(fixture) {
  if (!fixture) return;
  await new Promise((resolve) => fixture.server.close(() => resolve()));
  fs.rmSync(fixture.dataDir, { recursive: true, force: true });
}

async function apiRequest(baseUrl, route, options = {}) {
  const response = await fetch(baseUrl + route, {
    cache: 'no-store',
    ...options,
    headers: { ...(options.headers || {}) }
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body, headers: response.headers };
}

function rawRequest(baseUrl, route, { method = 'POST', body = '', headers = {} } = {}) {
  return new Promise((resolve) => {
    const target = new URL(baseUrl + route);
    const req = require('http').request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers: { 'Content-Length': Buffer.byteLength(body), ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (error) => resolve({ error }));
    req.end(body);
  });
}

module.exports = { makeDb, startHttpFixture, stopHttpFixture, apiRequest, rawRequest };
