const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_DB = {
  tasks: [],
  todos: [],
  notes: [],
  files: [],
  settings: { assistants: [], viewers: [] }
};

function cloneDefaultDb() {
  return JSON.parse(JSON.stringify(DEFAULT_DB));
}

function normalizeDb(db) {
  db.settings = db.settings || {};
  db.tasks = db.tasks || [];
  db.todos = db.todos || [];
  db.notes = db.notes || [];
  db.files = db.files || [];
  db.settings.assistants = db.settings.assistants || [];
  db.settings.viewers = db.settings.viewers || [];
  return db;
}

class JsonRepository {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dbFile = path.join(dataDir, 'workbench.json');
    this.writeQueue = Promise.resolve();
  }

  read() {
    try {
      if (fs.existsSync(this.dbFile)) {
        return normalizeDb(JSON.parse(fs.readFileSync(this.dbFile, 'utf8')));
      }
    } catch (error) {
      console.error('数据库读取失败，使用空库:', error.message);
    }
    return cloneDefaultDb();
  }

  write(db) {
    this.writeQueue = this.writeQueue.then(() => this.writeNow(normalizeDb(db)));
    return this.writeQueue;
  }

  writeNow(db) {
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
    this.backupCurrentFile();
    const tmpFile = this.dbFile + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmpFile, this.dbFile);
  }

  backupCurrentFile() {
    if (!fs.existsSync(this.dbFile)) return;
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const backupFile = path.join(this.dataDir, `workbench-${stamp}.json.bak`);
      fs.copyFileSync(this.dbFile, backupFile);
      const backups = fs.readdirSync(this.dataDir)
        .filter((file) => file.endsWith('.json.bak'))
        .sort();
      while (backups.length > 5) fs.unlinkSync(path.join(this.dataDir, backups.shift()));
    } catch (error) {
      console.error('数据库备份失败，继续保存:', error.message);
    }
  }

  ensureApiToken() {
    const db = this.read();
    if (!db.settings.apiToken) {
      db.settings.apiToken = crypto.randomBytes(16).toString('hex');
      return this.write(db).then(() => db.settings.apiToken);
    }
    return Promise.resolve(db.settings.apiToken);
  }

  ensureOwnerToken() {
    const db = this.read();
    if (!db.settings.ownerToken) {
      db.settings.ownerToken = db.settings.shareToken || crypto.randomBytes(6).toString('hex');
      return this.write(db).then(() => db.settings.ownerToken);
    }
    return Promise.resolve(db.settings.ownerToken);
  }
}

module.exports = { JsonRepository };
