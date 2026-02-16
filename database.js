const Database = require('better-sqlite3');
const db = new Database('database.db');

db.prepare(`
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY,
  channelId TEXT NOT NULL,
  user1Id TEXT NOT NULL,
  user2Id TEXT NOT NULL,
  senderId TEXT,
  receiverId TEXT,
  amount REAL DEFAULT 0,
  fee REAL DEFAULT 0,
  feePercent REAL DEFAULT 5,
  ltcPrice REAL DEFAULT 0,
  ltcAmount TEXT,
  totalLtc TEXT,
  depositAddress TEXT,
  receiverAddress TEXT,
  refundAddress TEXT,
  senderAddress TEXT,
  txid TEXT,
  user1Confirmed INTEGER DEFAULT 0,
  user2Confirmed INTEGER DEFAULT 0,
  status TEXT DEFAULT 'selecting_roles',
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  paidAt DATETIME,
  completedAt DATETIME,
  refundedAt DATETIME
)`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
)`).run();

db.prepare(`CREATE INDEX IF NOT EXISTS idx_trades_channel ON trades(channelId)`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status)`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_trades_sender ON trades(senderId)`).run();

console.log('✅ Database initialized');

module.exports = db;
