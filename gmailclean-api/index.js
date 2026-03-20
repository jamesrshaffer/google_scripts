const express = require('express');
const mysql = require('mysql2/promise');

const app = express();
app.use(express.json());
app.use(express.static('public'));
const API_KEY = process.env.API_KEY;

const db = mysql.createPool({
  host: 'mariadb',
  user: 'gmailuser',
  password: process.env.DB_PASSWORD,
  database: 'gmailclean',
  waitForConnections: true,
  connectionLimit: 10
});

// Auth middleware — runs before every route
function requireKey(req, res, next) {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// POST /messages — bulk insert metadata from Apps Script
app.post('/messages', requireKey, async (req, res) => {
  const messages = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Expected non-empty array' });
  }
  const rows = messages.map(m => [
    m.thread_id, m.message_id, m.sender,
    m.sender_domain, m.subject, m.received_date, m.label
  ]);
  await db.query(
    `INSERT IGNORE INTO messages
     (thread_id, message_id, sender, sender_domain, subject, received_date, label)
     VALUES ?`,
    [rows]
  );
  res.json({ inserted: rows.length });
});

// GET /flagged — return message_ids flagged for deletion
app.get('/flagged', requireKey, async (req, res) => {
  const [rows] = await db.query(
    'SELECT message_id FROM messages WHERE flagged_delete=1 AND trashed=0'
  );
  res.json(rows.map(r => r.message_id));
});

// POST /trashed — mark message_ids as trashed
app.post('/trashed', requireKey, async (req, res) => {
  const ids = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Expected non-empty array' });
  }
  await db.query(
    'UPDATE messages SET trashed=1 WHERE message_id IN (?)',
    [ids]
  );
  res.json({ updated: ids.length });
});
// GET /stats — summary counts for daily report
app.get('/stats', requireKey, async (req, res) => {
  const [[totals]] = await db.query(`
    SELECT 
      COUNT(*) as total_messages,
      SUM(flagged_delete) as total_flagged,
      SUM(trashed) as total_trashed,
      COUNT(DISTINCT sender_domain) as total_domains
    FROM messages
  `);
  const [domains] = await db.query(`
    SELECT sender_domain, total, flagged, trashed,
           (total - trashed) as remaining
    FROM v_domain_summary
    WHERE flagged = 0 AND trashed < total
    ORDER BY total DESC
    LIMIT 100
  `);
  res.json({ totals, domains });
});

// POST /protect — add domains to protected list
app.post('/protect', requireKey, async (req, res) => {
  const domains = req.body;
  if (!Array.isArray(domains) || domains.length === 0) {
    return res.json({ protected: 0 });
  }
  const rows = domains.map(d => [d, 'user-protected']);
  await db.query(
    'INSERT IGNORE INTO protected_domains (domain, reason) VALUES ?',
    [rows]
  );
  res.json({ protected: domains.length });
});

// POST /flag-domains — flag all messages from given domains
app.post('/flag-domains', requireKey, async (req, res) => {
  const domains = req.body;
  if (!Array.isArray(domains) || domains.length === 0) {
    return res.json({ flagged: 0 });
  }
  const [result] = await db.query(
    'UPDATE messages SET flagged_delete=1 WHERE trashed=0 AND flagged_delete=0 AND sender_domain IN (?)',
    [domains]
  );
  res.json({ flagged: result.affectedRows });
});

// POST /auto-flag-partial — flag remaining messages for domains already partially flagged
app.post('/auto-flag-partial', requireKey, async (req, res) => {
  const [result] = await db.query(`
    UPDATE messages SET flagged_delete = 1
    WHERE flagged_delete = 0
      AND trashed = 0
      AND sender_domain IN (
        SELECT sender_domain FROM v_domain_summary
        WHERE flagged > 0 AND (total - trashed) > 0 AND flagged < total
      )
  `);
  res.json({ flagged: result.affectedRows });
});

// GET /protected-domains — protected domains with untrashed message counts, ascending
app.get('/protected-domains', requireKey, async (req, res) => {
  const [rows] = await db.query(`
    SELECT p.domain,
           COUNT(m.message_id) as total,
           SUM(CASE WHEN m.flagged_delete=1 THEN 1 ELSE 0 END) as flagged
    FROM protected_domains p
    LEFT JOIN messages m ON m.sender_domain = p.domain AND m.trashed = 0
    GROUP BY p.domain
    HAVING total > 0
    ORDER BY total ASC
  `);
  res.json(rows);
});

// GET /messages/:domain — untrashed, unflagged messages for a domain
app.get('/messages/:domain', requireKey, async (req, res) => {
  const [rows] = await db.query(`
    SELECT message_id, sender, subject, received_date
    FROM messages
    WHERE sender_domain = ?
      AND trashed = 0
      AND flagged_delete = 0
    ORDER BY received_date DESC
    LIMIT 200
  `, [req.params.domain]);
  res.json(rows);
});

// POST /flag-messages — flag specific message IDs for deletion
app.post('/flag-messages', requireKey, async (req, res) => {
  const ids = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Expected non-empty array' });
  }
  const [result] = await db.query(
    'UPDATE messages SET flagged_delete=1 WHERE message_id IN (?) AND trashed=0',
    [ids]
  );
  res.json({ flagged: result.affectedRows });
});

app.listen(3000, () => console.log('gmailclean-api listening on port 3000'));
