#!/usr/bin/env node
const crypto = require('crypto');
const { db } = require('../db');
const { hashPassword } = require('../auth');

const [, , action, username, password] = process.argv;

function usage() {
  console.log(`Usage:
  node src/scripts/users.js add <username> [password]
  node src/scripts/users.js remove <username>
  node src/scripts/users.js list`);
  process.exit(1);
}

if (!action) usage();

if (action === 'add') {
  if (!username) usage();
  const normalized = String(username).trim().toLowerCase();
  const pw = password || crypto.randomBytes(8).toString('base64url');
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(normalized);
  if (exists) {
    console.error(`User "${normalized}" already exists.`);
    process.exit(1);
  }
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(
    normalized,
    hashPassword(pw)
  );
  console.log(`User "${normalized}" created.`);
  if (!password) console.log(`Generated password: ${pw}`);
  console.log('Restart the server for the change to take effect (login reads live).');
} else if (action === 'remove') {
  if (!username) usage();
  const normalized = String(username).trim().toLowerCase();
  const info = db.prepare('DELETE FROM users WHERE username = ?').run(normalized);
  if (info.changes === 0) {
    console.error(`User "${normalized}" not found.`);
    process.exit(1);
  }
  console.log(`User "${normalized}" removed.`);
} else if (action === 'list') {
  const rows = db.prepare('SELECT username, created_at FROM users ORDER BY username').all();
  if (rows.length === 0) {
    console.log('No users yet.');
  } else {
    for (const r of rows) console.log(`${r.username}  (created ${r.created_at})`);
  }
} else {
  usage();
}
