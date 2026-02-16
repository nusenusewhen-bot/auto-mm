const Database = require('better-sqlite3');
const db = new Database('database.db');

db.prepare(`
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channelId TEXT NOT NULL,
  user1Id TEXT NOT NULL,
  user2Id TEXT NOT NULL,
  senderId TEXT,
  receiverId TEXT,
  amount REAL DEFAULT 0,
  fee REAL DEFAULT 0,
  feePercent REAL DEFAULT 5,
  ltcPrice REAL DEFAULT 0,
  ltcAmount REAL DEFAULT 0,
  totalLtc REAL DEFAULT 0,
  depositAddress TEXT,
  depositIndex INTEGER DEFAULT 0,
  receiverAddress TEXT,
  txid TEXT,
  status TEXT DEFAULT 'role_selection',
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  paidAt DATETIME,
  completedAt DATETIME
)`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
)`).run();

console.log('✅ Database initialized');

module.exports = db;
