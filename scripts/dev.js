/**
 * Local development server.
 *
 * Runs the *exact same* application code as the Cloudflare Worker, backed by
 * Node's built-in SQLite (or Turso, when TURSO_DATABASE_URL is configured), so
 * the whole product is testable with zero cloud credentials.
 *
 *   npm run dev          -> http://localhost:8787
 */

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleRequest } from '../src/app.js';
import { ensureSchema } from '../src/db/schema.js';
import { createNodeDb } from '../src/db/node-sqlite.js';
import { createTursoDb } from '../src/db/turso.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

/** Minimal `.env`-style parser for `.dev.vars` (same format wrangler uses). */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

/** @returns {Promise<Record<string, string>>} */
export async function loadEnv() {
  /** @type {Record<string, string>} */
  const fileEnv = {};
  for (const name of ['.dev.vars', '.env']) {
    const file = path.join(ROOT, name);
    if (existsSync(file)) {
      Object.assign(fileEnv, parseEnvFile(await readFile(file, 'utf8')));
    }
  }
  return { ...fileEnv, .../** @type {Record<string, string>} */ (process.env) };
}

/** Pick the database: Turso when configured, otherwise local SQLite. */
export async function createDb(env) {
  const url = env.TURSO_DATABASE_URL;
  if (url && /^(libsql|https?):\/\//.test(url) && env.TURSO_AUTH_TOKEN) {
    console.log('[mantisbin] using Turso database from TURSO_DATABASE_URL');
    return createTursoDb(env);
  }
  const file = env.DB_FILE || path.join(ROOT, '.data', 'mantisbin.db');
  if (file !== ':memory:') {
    await mkdir(path.dirname(file), { recursive: true });
  }
  console.log(`[mantisbin] using local SQLite at ${file}`);
  return createNodeDb(file);
}

async function serveStatic(urlPath, res) {
  const relative = path.normalize(urlPath).replace(/^([/\\])+/, '');
  const file = path.join(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
  try {
    const data = await readFile(file);
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const env = await loadEnv();
  const db = await createDb(env);
  await ensureSchema(db);

  const host = env.HOST || '0.0.0.0';
  const port = Number(env.PORT || 8787);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `localhost:${port}`}`);

    if ((req.method === 'GET' || req.method === 'HEAD') && (await serveStatic(url.pathname, res))) {
      return;
    }

    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      let body;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = Buffer.concat(chunks);
      }
      const request = new Request(url.href, { method: req.method, headers, body });
      const response = await handleRequest({ request, env, db });

      const responseHeaders = {};
      for (const [key, value] of response.headers.entries()) responseHeaders[key] = value;
      const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
      if (setCookies.length) responseHeaders['set-cookie'] = setCookies;

      res.writeHead(response.status, /** @type {any} */ (responseHeaders));
      if (req.method === 'HEAD' || !response.body) {
        res.end();
        return;
      }
      for await (const chunk of /** @type {any} */ (response.body)) res.write(chunk);
      res.end();
    } catch (error) {
      console.error('[mantisbin] dev server error', error);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal dev server error');
    }
  });

  server.listen(port, host, () => {
    console.log(`[mantisbin] dev server on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log('[mantisbin] Stay sharp. Paste faster.');
  });
}

// Only start the server when executed directly (scripts/cleanup.js reuses loadEnv/createDb).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
