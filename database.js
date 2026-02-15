const Database = require('better-sqlite3');
const db = new Database('database.db');

// Trades table
db.prepare(`
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channelId TEXT,
  senderId TEXT,
  receiverId TEXT,
  youGive TEXT,
  theyGive TEXT,
  amount REAL,
  fee REAL,
  depositAddress TEXT,
  senderChosen INTEGER DEFAULT 0,
  receiverChosen INTEGER DEFAULT 0,
  status TEXT DEFAULT 'waiting',
  confirmed INTEGER DEFAULT 0
)`).run();

// Config table for log channel
db.prepare(`
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
)`).run();

module.exports = db;
