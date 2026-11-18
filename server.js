#!/usr/bin/env node
/**
 * Kleine nul-afhankelijkheid server voor de landingspagina:
 *
 *   - serves index.html / admin.html (en andere bestanden in de map)
 *   - GET  /api/config  -> huidige live-instellingen (pixel, cloaker, kanalen)
 *   - POST /api/config  -> slaat op EN past index.html direct aan (live)
 *   - POST /api/stats   -> registreert bezoek/klik per kanaal-index
 *   - GET  /api/stats   -> JSON-overzicht (door admin.html gebruikt)
 *   - GET  /api/health  -> statuscontrole
 *
 * Data wordt opgeslagen in $DATA_DIR (default: deze map):
 *   site-config.json, stats.json
 *
 * Geen npm-dependencies; draait met `node server.js`.
 * Railway / Nixpacks: start = `node server.js`, poort via $PORT.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || ROOT;
const PORT = process.env.PORT || 8899;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const INDEX_FILE = path.join(ROOT, 'index.html');
const CONFIG_FILE = path.join(DATA_DIR, 'site-config.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* noop */ }

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

/* ================================================================== *
 *  Kanaal-normalisatie (identiek aan index.html / admin.html)
 * ================================================================== */
function normalizeChannel(input) {
  const raw = String(input || '').trim();
  if (!raw) { return { kind: 'empty', value: '', web: '', deep: '' }; }

  let s = raw
    .replace(/^tg:\/\/resolve\?domain=/i, '')
    .replace(/^tg:\/\/join\?invite=/i, '')
    .replace(/^https?:\/\//i, '')
    .replace(/^(t|telegram)\.me\//i, '');

  s = s.replace(/^@/, '').replace(/^joinchat\//i, '+');
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '');

  if (!s) { return { kind: 'empty', value: '', web: '', deep: '' }; }

  if (s.charAt(0) === '+') {
    const hash = s.slice(1);
    return { kind: 'invite', value: '+' + hash,
             web: 'https://t.me/+' + hash, deep: 'tg://join?invite=' + hash };
  }

  return { kind: 'public', value: s,
           web: 'https://t.me/' + s, deep: 'tg://resolve?domain=' + s };
}

/* ================================================================== *
 *  Config: validatie + opslag
 * ================================================================== */
function validateConfig(input) {
  const errors = [];
  const cfg = { pixelId: '', cloaker: '', channels: [] };
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['Ongeldige inhoud.'], value: cfg };
  }

  const pixel = String(input.pixelId || '').trim();
  if (!pixel) {
    errors.push('Pixel ID ontbreekt.');
  } else if (!/^\d{5,20}$/.test(pixel)) {
    errors.push('Pixel ID mag alleen cijfers bevatten.');
  } else {
    cfg.pixelId = pixel;
  }

  const cloaker = String(input.cloaker || '').trim();
  if (cloaker && !/^https?:\/\/[^\s]+\.[^\s]+/i.test(cloaker)) {
    errors.push('Cloaker-link is geen geldige URL.');
  } else {
    cfg.cloaker = cloaker;
  }

  const list = Array.isArray(input.channels) ? input.channels : [];
  const now = Date.now();
  const seen = new Set();

  list.forEach(function (item) {
    const link = item && typeof item === 'object' ? item.link : item;
    const added = item && typeof item === 'object' ? Number(item.addedAt) : 0;

    const n = normalizeChannel(link);
    if (n.kind === 'empty') { return; }
    if (n.kind === 'invite' && n.value.length < 8) {
      errors.push('Invite-link "' + n.value + '" is onvolledig.');
      return;
    }
    if (n.kind === 'public' && !/^[A-Za-z0-9_]{3,64}$/.test(n.value)) {
      errors.push('Kanaalnaam "' + n.value + '" is ongeldig.');
      return;
    }
    if (seen.has(n.value)) { return; }
    seen.add(n.value);

    cfg.channels.push({
      link: n.value,
      addedAt: (isFinite(added) && added > 0) ? Math.floor(added) : now
    });
  });

  if (!cfg.channels.length) {
    errors.push('Minimaal één kanaal is verplicht.');
  }
  if (cfg.channels.length > 50) {
    errors.push('Maximaal 50 kanalen.');
  }

  return { ok: errors.length === 0, errors: errors, value: cfg };
}

function readConfigFile() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8').replace(/^﻿/, '');
    const parsed = JSON.parse(raw);
    const res = validateConfig(parsed);
    return res.ok ? res.value : null;
  } catch (e) {
    return null;
  }
}

function writeConfigFile(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

/* Standaardwaarden uit index.html halen (als er nog niets is opgeslagen) */
function readDefaultsFromIndex() {
  const out = { pixelId: '', cloaker: '', channels: [] };
  let html;
  try { html = fs.readFileSync(INDEX_FILE, 'utf-8'); }
  catch (e) { return out; }

  const m = html.match(/\/\* <<<CONFIG_START>>> \*\/([\s\S]*?)\/\* <<<CONFIG_END>>> \*\//);
  if (!m) { return out; }
  const body = m[1];

  const pixel = body.match(/pixelId\s*:\s*["']([^"']*)["']/);
  if (pixel && pixel[1] && pixel[1] !== 'YOUR_PIXEL_ID') { out.pixelId = pixel[1]; }

  const cloak = body.match(/cloaker\s*:\s*["']([^"']*)["']/);
  if (cloak && cloak[1]) { out.cloaker = cloak[1]; }

  const arr = body.match(/channels\s*:\s*\[([\s\S]*?)\]\s*\n?\s*\}/);
  if (arr) {
    const re = /link\s*:\s*["']([^"']*)["']\s*(?:,\s*addedAt\s*:\s*([\d.]+))?/g;
    let hit;
    while ((hit = re.exec(arr[1]))) {
      const link = hit[1];
      if (!link || link === 'YOUR_CHANNEL') { continue; }
      out.channels.push({ link: link, addedAt: parseFloat(hit[2]) || 0 });
    }
  }

  return out;
}

function currentConfig() {
  return readConfigFile() || readDefaultsFromIndex();
}

/* ================================================================== *
 *  index.html live aanpassen
 * ================================================================== */
function buildConfigBlock(cfg) {
  const entries = cfg.channels.map(function (c) {
    return '    { link: ' + JSON.stringify(c.link) +
           ', addedAt: ' + Math.floor(c.addedAt || Date.now()) + ' }';
  });

  return '/* <<<CONFIG_START>>> */\n' +
    'window.SITE_CONFIG = {\n' +
    '  pixelId: ' + JSON.stringify(cfg.pixelId) + ',\n' +
    '  cloaker: ' + JSON.stringify(cfg.cloaker || '') + ',\n' +
    '  channels: [\n' + entries.join(',\n') + '\n  ]\n' +
    '};\n' +
    '/* <<<CONFIG_END>>> */';
}

function applyConfig(html, cfg) {
  if (!cfg) { return html; }

  let out = html.replace(
    /\/\* <<<CONFIG_START>>> \*\/[\s\S]*?\/\* <<<CONFIG_END>>> \*\//,
    buildConfigBlock(cfg)
  );

  if (cfg.pixelId) {
    out = out.replace(
      /facebook\.com\/tr\?id=[^&"'\s]+&ev=PageView&noscript=1/g,
      'facebook.com/tr?id=' + encodeURIComponent(cfg.pixelId) + '&ev=PageView&noscript=1'
    );
  }

  const first = cfg.channels.filter(function (c) { return c.link; })[0];
  if (first) {
    const web = normalizeChannel(first.link).web;
    out = out.replace(
      /(<a id="cta-noscript" href=")[^"]*(")/,
      function (_, a, b) { return a + web + b; }
    );
  }

  return out;
}

/* ================================================================== *
 *  Stats
 * ================================================================== */
let stats = { days: {} };

function loadStats() {
  try {
    const raw = fs.readFileSync(STATS_FILE, 'utf-8').replace(/^﻿/, '');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.days) { stats = parsed; }
  } catch (e) {
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
  if (!stats.days[key]) { stats.days[key] = {}; }

  const day = stats.days[key];
  const idx = String(channelIdx);

  if (!day[idx]) { day[idx] = { visits: 0, clicks: 0 }; }
  if (type === 'visit') { day[idx].visits += 1; }
  else if (type === 'click') { day[idx].clicks += 1; }

  saveStats();
}

function summarize(daysBack) {
  const out = { days: {}, total: { visits: 0, clicks: 0 } };
  const cutoff = new Date(Date.now() - daysBack * 86400000);

  Object.keys(stats.days).sort().forEach(function (key) {
    if (new Date(key + 'T00:00:00Z') < cutoff) { return; }
    out.days[key] = stats.days[key];
    Object.keys(stats.days[key]).forEach(function (idx) {
      out.total.visits += stats.days[key][idx].visits || 0;
      out.total.clicks += stats.days[key][idx].clicks || 0;
    });
  });

  return out;
}

/* ================================================================== *
 *  HTTP-helpers
 * ================================================================== */
function readBody(req, limit, cb) {
  let data = '';
  let tooBig = false;

  req.on('data', function (c) {
    if (tooBig) { return; }
    data += c;
    if (data.length > limit) { tooBig = true; }
  });
  req.on('end', function () { cb(tooBig ? null : data); });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/* Timer-veilige authenticatie: vergelijk elke hex-char apart
   zodat de vergelijkingstijd niet van de tokeninhoud afhangt. */
function safeEqual(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) { return false; }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAdmin(req) {
  if (!ADMIN_TOKEN) { return true; } // geen token gezet -> open (lokale dev)
  const header = req.headers['x-admin-token'];
  if (header && safeEqual(String(header).trim(), ADMIN_TOKEN)) { return true; }

  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m && safeEqual(m[1].trim(), ADMIN_TOKEN)) { return true; }

  const q = (req.url || '').split('?')[1] || '';
  const token = (new URLSearchParams(q)).get('token');
  return !!(token && safeEqual(token, ADMIN_TOKEN));
}

/* ================================================================== *
 *  API
 * ================================================================== */
function handleApi(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch (e) { sendJson(res, 400, { error: 'bad request' }); return; }

  /* ---- health ---- */
  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, uptime: process.uptime() });
    return;
  }

  /* ---- config ---- */
  if (url.pathname === '/api/config') {
    if (req.method === 'GET') {
      if (!isAdmin(req)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      sendJson(res, 200, currentConfig());
      return;
    }

    if (req.method === 'POST') {
      if (!isAdmin(req)) {
        sendJson(res, 401, { ok: false, errors: ['Ongeldig wachtwoord of niet ingelogd.'] });
        return;
      }
      readBody(req, 100000, function (body) {
        if (body === null) {
          sendJson(res, 413, { ok: false, errors: ['Payload te groot.'] });
          return;
        }

        let parsed;
        try { parsed = JSON.parse(body); }
        catch (e) {
          sendJson(res, 400, { ok: false, errors: ['Ongeldige JSON.'] });
          return;
        }

        const result = validateConfig(parsed);
        if (!result.ok) {
          sendJson(res, 422, { ok: false, errors: result.errors });
          return;
        }

        try {
          writeConfigFile(result.value);
        } catch (e) {
          sendJson(res, 500, { ok: false, errors: ['Opslaan mislukt: ' + e.message] });
          return;
        }

        sendJson(res, 200, { ok: true, config: result.value });
      });
      return;
    }

    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  /* ---- stats ---- */
  if (url.pathname === '/api/stats') {
    if (req.method === 'POST') {
      readBody(req, 10000, function (body) {
        if (body === null) { res.writeHead(204); res.end(); return; }

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

    if (!isAdmin(req)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    let back = parseInt(url.searchParams.get('days'), 10);
    if (!isFinite(back) || back < 1 || back > 365) { back = 30; }
    sendJson(res, 200, summarize(back));
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

/* ================================================================== *
 *  Statische bestanden (index.html krijgt live de config geïnjecteerd)
 * ================================================================== */
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

  // Config-injectie geldt alleen voor index.html (admin.html bevat dezelfde
  // marker in een JS-string en mag niet worden aangepast).
  const isIndex = file.toLowerCase() === INDEX_FILE.toLowerCase();

  fs.readFile(file, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404');
      return;
    }

    const ext = path.extname(file).toLowerCase();
    let payload = data;

    if (isIndex && ext === '.html') {
      try {
        const html = data.toString('utf-8');
        const cfg = readConfigFile();
        if (cfg) {
          payload = Buffer.from(applyConfig(html, cfg), 'utf-8');
        }
      } catch (e) {
        payload = data; // nooit stukgaan op de injectie
      }
    }

    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(payload);
  });
}

/* ================================================================== *
 *  Server
 * ================================================================== */
loadStats();

const server = http.createServer(function (req, res) {
  if (req.url && req.url.indexOf('/api/') === 0) {
    handleApi(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, function () {
  console.log('[nob] server draait op http://localhost:' + PORT);
  console.log('[nob] data: ' + DATA_DIR);
});
