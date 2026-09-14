import express from 'express';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize database
const db = new Database(path.join(__dirname, 'data', 'mantisbin.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS pastes (
    id TEXT PRIMARY KEY,
    title TEXT,
    content TEXT NOT NULL,
    visibility TEXT DEFAULT 'public',
    expires_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    views INTEGER DEFAULT 0
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_expires ON pastes(expires_at)`);

// Rate limiter: 60 requests per minute per IP for paste creation
const rateLimiter = new RateLimiterMemory({
  points: 60,
  duration: 60,
});

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Cleanup expired pastes on startup and every hour
function cleanupExpiredPastes() {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('DELETE FROM pastes WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
}

cleanupExpiredPastes();
setInterval(cleanupExpiredPastes, 3600000);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Create paste
app.post('/api/paste', async (req, res) => {
  try {
    await rateLimiter.consume(req.ip);
  } catch {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }

  const { title, content, visibility, expiresIn } = req.body;

  // Server-side validation
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'Content is required.' });
  }

  if (content.length > 1048576) {
    return res.status(400).json({ error: 'Content exceeds maximum size of 1MB.' });
  }

  const safeTitle = title && typeof title === 'string' 
    ? title.slice(0, 200) 
    : null;

  const validVisibilities = ['public', 'unlisted'];
  const safeVisibility = validVisibilities.includes(visibility) 
    ? visibility 
    : 'public';

  let expiresAt = null;
  const validExpirations = [3600, 86400, 604800, 2592000]; // 1h, 1d, 1w, 30d
  if (expiresIn && validExpirations.includes(parseInt(expiresIn))) {
    expiresAt = Math.floor(Date.now() / 1000) + parseInt(expiresIn);
  }

  const id = uuidv4().replace(/-/g, '').slice(0, 12);
  const createdAt = Math.floor(Date.now() / 1000);

  try {
    db.prepare(`
      INSERT INTO pastes (id, title, content, visibility, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, safeTitle, content, safeVisibility, expiresAt, createdAt);

    res.json({
      id,
      url: `/p/${id}`,
      fullUrl: `${req.protocol}://${req.get('host')}/p/${id}`,
    });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ error: 'Failed to create paste.' });
  }
});

// Get paste
app.get('/api/paste/:id', (req, res) => {
  const { id } = req.params;

  if (!id || !/^[a-zA-Z0-9]{12}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid paste ID.' });
  }

  const paste = db.prepare('SELECT * FROM pastes WHERE id = ?').get(id);

  if (!paste) {
    return res.status(404).json({ error: 'Paste not found.' });
  }

  if (paste.expires_at && paste.expires_at < Math.floor(Date.now() / 1000)) {
    db.prepare('DELETE FROM pastes WHERE id = ?').run(id);
    return res.status(404).json({ error: 'Paste has expired.' });
  }

  // Increment view count
  db.prepare('UPDATE pastes SET views = views + 1 WHERE id = ?').run(id);

  res.json({
    id: paste.id,
    title: paste.title,
    content: paste.content,
    visibility: paste.visibility,
    createdAt: paste.created_at,
    views: paste.views + 1,
  });
});

// Delete paste (optional, for owner cleanup if we had auth)
app.delete('/api/paste/:id', (req, res) => {
  const { id } = req.params;

  if (!id || !/^[a-zA-Z0-9]{12}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid paste ID.' });
  }

  const result = db.prepare('DELETE FROM pastes WHERE id = ?').run();

  if (result.changes > 0) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Paste not found.' });
  }
});

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve paste page
app.get('/p/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'paste.html'));
});

app.listen(PORT, () => {
  console.log(`MantisBin running on http://localhost:${PORT}`);
  console.log('Stay sharp. Paste faster.');
});
