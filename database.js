const Database = require('better-sqlite3');
const db = new Database('database.db');

db.prepare(`
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channelId TEXT,
  senderId TEXT,
  receiverId TEXT,
  amount REAL,
  fee REAL,
  depositAddress TEXT,
  status TEXT DEFAULT 'waiting',
  confirmed INTEGER DEFAULT 0
)`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
)`).run();

module.exports = db;
