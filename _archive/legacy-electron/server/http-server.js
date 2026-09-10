const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const API_PORT = 17500;
const MAX_BODY_BYTES = 1024 * 1024;

function getLanIps() {
  const ips = [];
  for (const network of Object.values(os.networkInterfaces())) {
    for (const item of network || []) {
      if (item.family === 'IPv4' && !item.internal) ips.push(item.address);
    }
  }
  return ips;
}

function getLanIp() {
  return getLanIps()[0] || '127.0.0.1';
}

function getMime(filePath) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };
  return types[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function resolveIdentity(db, token) {
  if (!token) return null;
  if (token === db.settings.ownerToken) return { role: 'owner' };
  for (const assistant of db.settings.assistants || []) {
    if (assistant.token === token) return { role: 'assistant', id: assistant.id, name: assistant.name };
  }
  for (const viewer of db.settings.viewers || []) {
    if (viewer.token === token) return { role: 'viewer', id: viewer.id, name: viewer.name };
  }
  return null;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error('request body too large'));
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (error) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function createTask(payload, options) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: options.title,
    desc: String(payload.desc || payload.note || ''),
    priority: ['P0', 'P1', 'P2'].includes(payload.priority) ? payload.priority : 'P1',
    status: 'todo',
    progress: 0,
    due: typeof payload.due === 'string' && payload.due ? payload.due : null,
    assignee: options.assignee,
    logs: [{ t: now, text: options.log }],
    source: options.source,
    createdAt: now,
    doneAt: null
  };
}

function startHttpServer({ rootDir, repository, notifyChanged, port = API_PORT }) {
  const shareDir = path.join(rootDir, 'share');
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const route = requestUrl.pathname;
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };
    const saveAndNotify = async (db, reason) => {
      await repository.write(db);
      notifyChanged(reason);
    };

    try {
      if (req.method === 'GET' && (route === '/' || route === '/share')) {
        const html = fs.readFileSync(path.join(shareDir, 'share.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      if (req.method === 'GET' && route.startsWith('/share/')) {
        const filePath = path.resolve(shareDir, '.' + route.slice('/share'.length));
        if (!filePath.startsWith(shareDir + path.sep)) return send(403, { ok: false });
        try {
          res.writeHead(200, { 'Content-Type': getMime(filePath) });
          return res.end(fs.readFileSync(filePath));
        } catch {
          return send(404, { ok: false });
        }
      }
      if (req.method === 'GET' && route === '/api/ping') return send(200, { ok: true, name: 'personal-workbench' });

      const db = repository.read();
      if (req.method === 'GET' && route === '/api/share/me') {
        const who = resolveIdentity(db, requestUrl.searchParams.get('token') || '');
        if (!who) return send(401, { ok: false, error: 'invalid token' });
        return send(200, {
          ok: true,
          who,
          assistants: db.settings.assistants.map(({ id, name }) => ({ id, name })),
          viewers: db.settings.viewers.map(({ id, name }) => ({ id, name }))
        });
      }

      if (req.method === 'GET' && route === '/api/share/tasks') {
        const who = resolveIdentity(db, requestUrl.searchParams.get('token') || '');
        if (!who) return send(401, { ok: false, error: 'invalid token' });
        let tasks = db.tasks;
        if (who.role === 'assistant') tasks = tasks.filter((task) => (task.assignee || 'me') === 'assistant:' + who.id);
        if (who.role === 'viewer') tasks = tasks.filter((task) => (task.assignee || 'me').startsWith('assistant:'));
        return send(200, { ok: true, tasks, now: Date.now() });
      }

      if (req.method === 'POST' && route === '/api/share/tasks') {
        const payload = await readJsonBody(req);
        const who = resolveIdentity(db, payload.token);
        if (!who) return send(401, { ok: false, error: 'invalid token' });
        if (who.role === 'viewer') return send(403, { ok: false, error: '查看者只读，不能发布任务' });
        const title = String(payload.title || '').trim();
        if (!title) return send(400, { ok: false, error: 'title required' });
        const assignee = who.role === 'assistant' ? 'assistant:' + who.id : (typeof payload.assignee === 'string' && payload.assignee ? payload.assignee : 'me');
        db.tasks.push(createTask(payload, {
          title,
          assignee,
          source: who.role === 'assistant' ? 'assistant' : 'manual',
          log: who.role === 'assistant' ? `由助理「${who.name}」发布` : '由主人发布'
        }));
        await saveAndNotify(db, 'share');
        return send(200, { ok: true });
      }

      const progressMatch = route.match(/^\/api\/share\/tasks\/([\w-]+)\/progress$/);
      if (req.method === 'POST' && progressMatch) {
        const payload = await readJsonBody(req);
        const who = resolveIdentity(db, payload.token);
        if (!who) return send(401, { ok: false, error: 'invalid token' });
        if (who.role === 'viewer') return send(403, { ok: false, error: '查看者只读，不能更新进展' });
        const task = db.tasks.find((item) => item.id === progressMatch[1]);
        if (!task) return send(404, { ok: false, error: 'task not found' });
        if (who.role === 'assistant' && (task.assignee || 'me') !== 'assistant:' + who.id) return send(403, { ok: false, error: '无权操作该任务' });
        if (typeof payload.progress === 'number') task.progress = Math.max(0, Math.min(100, Math.round(payload.progress)));
        const logText = String(payload.log || '').trim();
        if (logText) {
          task.logs = task.logs || [];
          task.logs.push({ t: Date.now(), text: logText, by: who.role === 'assistant' ? who.name : '我' });
        }
        if (task.progress >= 100 && task.status !== 'done') {
          task.status = 'done';
          task.doneAt = Date.now();
        } else if (task.progress < 100 && task.status === 'done') {
          task.status = task.progress > 0 ? 'in_progress' : 'todo';
          task.doneAt = null;
        } else if (task.progress > 0 && task.status === 'todo') {
          task.status = 'in_progress';
        }
        await saveAndNotify(db, 'share');
        return send(200, { ok: true, task: { id: task.id, status: task.status, progress: task.progress } });
      }

      const commentMatch = route.match(/^\/api\/share\/tasks\/([\w-]+)\/comment$/);
      if (req.method === 'POST' && commentMatch) {
        const payload = await readJsonBody(req);
        const who = resolveIdentity(db, payload.token);
        if (!who) return send(401, { ok: false, error: 'invalid token' });
        const task = db.tasks.find((item) => item.id === commentMatch[1]);
        if (!task) return send(404, { ok: false, error: 'task not found' });
        const assignee = task.assignee || 'me';
        const canSee = who.role === 'owner' || (who.role === 'assistant' && assignee === 'assistant:' + who.id) || (who.role === 'viewer' && assignee.startsWith('assistant:'));
        if (!canSee) return send(403, { ok: false, error: '无权评论该任务' });
        const text = String(payload.text || '').trim();
        if (!text) return send(400, { ok: false, error: 'text required' });
        task.comments = task.comments || [];
        task.comments.push({ t: Date.now(), text, by: who.role === 'owner' ? '主人' : who.name, role: who.role });
        await saveAndNotify(db, 'share');
        return send(200, { ok: true });
      }

      if (req.method === 'POST' && route === '/api/tasks') {
        const payload = await readJsonBody(req);
        if (payload.token !== db.settings.apiToken) return send(401, { ok: false, error: 'invalid token' });
        const title = String(payload.title || '').trim();
        if (!title) return send(400, { ok: false, error: 'title required' });
        db.tasks.push(createTask(payload, {
          title,
          assignee: typeof payload.assignee === 'string' && payload.assignee ? payload.assignee : 'me',
          source: 'wecom',
          log: '由外部接口创建'
        }));
        await saveAndNotify(db, 'api');
        return send(200, { ok: true });
      }
      return send(404, { ok: false });
    } catch (error) {
      console.error('HTTP 请求处理失败:', error.message);
      return send(error.message === 'request body too large' ? 413 : 400, { ok: false, error: error.message });
    }
  });

  server.on('error', (error) => console.error('API 服务启动失败:', error.message));
  server.listen(port, '0.0.0.0', async () => {
    const host = getLanIp();
    const ownerToken = await repository.ensureOwnerToken();
    const db = repository.read();
    console.log(`共享工作台已启动: http://${host}:${port}/ (局域网) / http://127.0.0.1:${port}/ (本机)`);
    console.log(`主人地址: http://${host}:${port}/?token=${ownerToken}`);
    for (const assistant of db.settings.assistants || []) console.log(`助理「${assistant.name}」地址: http://${host}:${port}/?token=${assistant.token}`);
    for (const viewer of db.settings.viewers || []) console.log(`查看者「${viewer.name}」地址: http://${host}:${port}/?token=${viewer.token}`);
  });
  return server;
}

module.exports = { getLanIp, startHttpServer };
