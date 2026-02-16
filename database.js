const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'tickets.db'));

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT UNIQUE NOT NULL,
    sender_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    giving TEXT NOT NULL,
    receiving TEXT NOT NULL,
    ltc_amount REAL NOT NULL,
    escrow_address TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting_deposit',
    channel_id TEXT,
    message_id TEXT,
    deposit_amount REAL,
    tx_hash TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_ticket_id ON tickets(ticket_id);
  CREATE INDEX IF NOT EXISTS idx_channel_id ON tickets(channel_id);
  CREATE INDEX IF NOT EXISTS idx_status ON tickets(status);
`);

console.log('✅ Database initialized');

module.exports = db;
