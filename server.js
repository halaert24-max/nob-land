#!/usr/bin/env node
/**
 * Kleine nul-afhankelijkheid server voor de landingspagina:
 *
 *   - serves index.html / admin.html (en andere bestanden in de map)
 *   - POST /api/stats   -> registreert bezoek/klik per kanaal-index
 *   - GET  /api/stats   -> JSON-overzicht (door admin.html gebruikt)
 *   - GET  /api/health  -> statuscontrole
 *
 * Data wordt opgeslagen in stats.json naast dit bestand.
 * Geen npm-dependencies; draait met plain `node server.js`.
 *
 * Nixpacks: start-commando = `node server.js` (poort via $PORT).
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 8899;
const STATS_FILE = path.join(ROOT, 'stats.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

/* ------------------------------------------------------------------ *
 *  Stats-opslag
 * ------------------------------------------------------------------ */
let stats = { days: {} };

function loadStats() {
  try {
    const raw = fs.readFileSync(STATS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.days) {
      stats = parsed;
    }
  } catch (e) {
    /* nog geen bestand of kapot -> vers beginnen */
    stats = { days: {} };
  }
}

function saveStats() {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
  } catch (e) {
    console.error('[stats] kon niet opslaan:', e.message);
  }
}

function dayKey(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function record(type, channelIdx) {
  const key = dayKey(new Date());
  if (!stats.days[key]) {
    stats.days[key] = {};
  }
  const day = stats.days[key];
  const idx = String(channelIdx);

  if (!day[idx]) {
    day[idx] = { visits: 0, clicks: 0 };
  }
  if (type === 'visit') {
    day[idx].visits += 1;
  } else if (type === 'click') {
    day[idx].clicks += 1;
  }
  saveStats();
}

function summarize(daysBack) {
  const out = { days: {}, total: { visits: 0, clicks: 0 } };

  // alleen de laatste N dagen overzetten (frontend filtert verder)
  const cutoff = new Date(Date.now() - daysBack * 86400000);
  Object.keys(stats.days).sort().forEach(function (key) {
    if (new Date(key + 'T00:00:00Z') >= cutoff) {
      out.days[key] = stats.days[key];
      Object.keys(stats.days[key]).forEach(function (idx) {
        out.total.visits += stats.days[key][idx].visits || 0;
        out.total.clicks += stats.days[key][idx].clicks || 0;
      });
    }
  });

  return out;
}

/* ------------------------------------------------------------------ *
 *  API-handlers
 * ------------------------------------------------------------------ */
function readBody(req, cb) {
  let data = '';
  req.on('data', function (c) {
    data += c;
    if (data.length > 1e4) { req.destroy(); } // max 10 KB
  });
  req.on('end', function () { cb(data); });
}

function handleApi(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
    return;
  }

  if (url.pathname === '/api/stats') {
    if (req.method === 'POST') {
      readBody(req, function (body) {
        const params = new URLSearchParams(body);
        const type = params.get('type') === 'click' ? 'click' : 'visit';
        let idx = parseInt(params.get('t'), 10);
        if (!isFinite(idx) || idx < 0 || idx > 500) { idx = 0; }
        record(type, idx);
        res.writeHead(204);
        res.end();
      });
      return;
    }

    // GET -> overzicht
    let back = parseInt(url.searchParams.get('days'), 10);
    if (!isFinite(back) || back < 1 || back > 365) { back = 30; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
                         'Cache-Control': 'no-store' });
    res.end(JSON.stringify(summarize(back)));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

/* ------------------------------------------------------------------ *
 *  Statische bestanden
 * ------------------------------------------------------------------ */
function serveStatic(req, res) {
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    p = '/';
  }

  if (p === '/') { p = '/index.html'; }

  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(file, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ *
 *  Server
 * ------------------------------------------------------------------ */
loadStats();

const server = http.createServer(function (req, res) {
  if (req.url.startsWith('/api/')) {
    handleApi(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, function () {
  console.log('[nob] server draait op http://localhost:' + PORT);
});
