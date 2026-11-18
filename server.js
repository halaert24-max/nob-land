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
const WHITEPAGE_FILE = path.join(ROOT, 'whitepage.html');
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
 *  Cloaker: bots/ad-reviewers zien whitepage.html, echte bezoekers de lander
 * ================================================================== */

/* Bekende bots en ad-reviewers (case-insensitive substring op de UA). */
const BOT_PATTERN = [
  'facebookexternalhit', 'facebookbot', 'facebot', 'meta-externalagent',
  'meta-externalarticle', 'quality browse', 'adsarchivebot', 'adreview',
  'googlebot', 'google-inspectiontool', 'adsbot-google',
  'mediapartners-google', 'googleadsbot', 'feedfetcher', 'lighthouse',
  'pagespeed', 'bingbot', 'applebot', 'yandexbot', 'twitterbot',
  'whatsapp', 'telegrambot', 'linkedinbot', 'petalbot', 'semrushbot',
  'ahrefsbot', 'mj12bot', 'dotbot', 'screaming frog', 'headlesschrome',
  'puppeteer', 'playwright', 'phantomjs', 'python-requests',
  'python-urllib', 'curl/', 'wget/', 'okhttp', 'libwww', 'java/',
  'go-http-client', 'scrapy', 'httpclient', 'apache-httpclient'
].join('|');

const BOT_RE = new RegExp(BOT_PATTERN, 'i');

/* Nederlandse IP-ranges (IPv4, RIPE-aggregated). */
const NL_V4 = [
  ['5.39.0.0', '5.39.255.255'],
  ['5.79.0.0', '5.79.255.255'],
  ['5.100.192.0', '5.100.255.255'],
  ['5.102.0.0', '5.102.63.255'],
  ['5.104.40.0', '5.104.43.255'],
  ['5.134.8.0', '5.134.11.255'],
  ['5.134.160.0', '5.134.191.255'],
  ['5.145.128.0', '5.145.159.255'],
  ['5.172.128.0', '5.172.191.255'],
  ['5.178.64.0', '5.178.95.255'],
  ['5.180.164.0', '5.180.167.255'],
  ['5.180.220.0', '5.180.223.255'],
  ['5.182.4.0', '5.182.7.255'],
  ['5.182.168.0', '5.182.171.255'],
  ['5.183.48.0', '5.183.51.255'],
  ['5.186.0.0', '5.187.255.255'],
  ['5.188.168.0', '5.188.171.255'],
  ['5.199.80.0', '5.199.87.255'],
  ['5.200.0.0', '5.207.255.255'],
  ['5.253.0.0', '5.253.3.255'],
  ['31.3.104.0', '31.3.107.255'],
  ['31.11.32.0', '31.11.39.255'],
  ['31.20.0.0', '31.23.255.255'],
  ['31.25.96.0', '31.25.103.255'],
  ['31.31.32.0', '31.31.39.255'],
  ['31.40.64.0', '31.40.71.255'],
  ['31.41.128.0', '31.41.191.255'],
  ['31.151.0.0', '31.151.255.255'],
  ['31.160.0.0', '31.163.255.255'],
  ['31.164.0.0', '31.165.255.255'],
  ['31.168.0.0', '31.171.255.255'],
  ['31.174.0.0', '31.174.255.255'],
  ['31.176.0.0', '31.176.255.255'],
  ['31.181.0.0', '31.181.255.255'],
  ['31.184.64.0', '31.184.71.255'],
  ['31.186.168.0', '31.186.175.255'],
  ['31.187.0.0', '31.187.63.255'],
  ['31.187.96.0', '31.187.99.255'],
  ['31.200.192.0', '31.200.199.255'],
  ['31.201.0.0', '31.201.63.255'],
  ['31.204.128.0', '31.204.159.255'],
  ['31.221.0.0', '31.221.255.255'],
  ['37.8.0.0', '37.8.255.255'],
  ['37.10.16.0', '37.10.31.255'],
  ['37.10.48.0', '37.10.63.255'],
  ['37.24.0.0', '37.24.255.255'],
  ['37.34.32.0', '37.34.63.255'],
  ['37.38.0.0', '37.39.255.255'],
  ['37.46.128.0', '37.46.191.255'],
  ['37.48.0.0', '37.49.255.255'],
  ['37.60.152.0', '37.60.159.255'],
  ['37.62.0.0', '37.63.255.255'],
  ['37.72.0.0', '37.75.255.255'],
  ['37.77.32.0', '37.77.63.255'],
  ['37.78.0.0', '37.78.255.255'],
  ['37.80.0.0', '37.83.255.255'],
  ['37.97.128.0', '37.97.255.255'],
  ['37.102.128.0', '37.102.255.255'],
  ['37.120.192.0', '37.120.199.255'],
  ['37.123.140.0', '37.123.143.255'],
  ['37.128.96.0', '37.128.111.255'],
  ['37.143.4.0', '37.143.7.255'],
  ['37.153.152.0', '37.153.155.255'],
  ['37.156.208.0', '37.156.215.255'],
  ['37.228.128.0', '37.228.135.255'],
  ['37.230.64.0', '37.230.71.255'],
  ['37.231.0.0', '37.231.255.255'],
  ['37.247.36.0', '37.247.39.255'],
  ['45.82.176.0', '45.82.183.255'],
  ['45.83.20.0', '45.83.23.255'],
  ['45.85.44.0', '45.85.47.255'],
  ['45.86.64.0', '45.86.67.255'],
  ['45.87.172.0', '45.87.175.255'],
  ['45.89.216.0', '45.89.219.255'],
  ['45.90.32.0', '45.90.35.255'],
  ['45.91.128.0', '45.91.131.255'],
  ['45.92.184.0', '45.92.187.255'],
  ['45.95.28.0', '45.95.31.255'],
  ['45.96.80.0', '45.96.83.255'],
  ['45.128.132.0', '45.128.135.255'],
  ['45.132.60.0', '45.132.63.255'],
  ['45.136.240.0', '45.136.243.255'],
  ['45.140.180.0', '45.140.183.255'],
  ['45.142.212.0', '45.142.215.255'],
  ['45.143.200.0', '45.143.207.255'],
  ['45.146.240.0', '45.146.243.255'],
  ['45.151.36.0', '45.151.39.255'],
  ['45.152.244.0', '45.152.247.255'],
  ['45.153.104.0', '45.153.107.255'],
  ['45.154.64.0', '45.154.67.255'],
  ['45.155.184.0', '45.155.187.255'],
  ['45.156.24.0', '45.156.27.255'],
  ['45.157.240.0', '45.157.243.255'],
  ['45.159.8.0', '45.159.11.255'],
  ['45.160.148.0', '45.160.151.255'],
  ['45.161.172.0', '45.161.175.255'],
  ['45.162.52.0', '45.162.55.255'],
  ['45.163.52.0', '45.163.55.255'],
  ['45.165.20.0', '45.165.23.255'],
  ['45.166.28.0', '45.166.31.255'],
  ['45.167.44.0', '45.167.47.255'],
  ['45.169.184.0', '45.169.187.255'],
  ['45.170.96.0', '45.170.99.255'],
  ['45.171.24.0', '45.171.27.255'],
  ['45.173.140.0', '45.173.143.255'],
  ['45.174.248.0', '45.174.251.255'],
  ['45.177.20.0', '45.177.23.255'],
  ['45.178.160.0', '45.178.163.255'],
  ['45.179.128.0', '45.179.131.255'],
  ['45.180.172.0', '45.180.175.255'],
  ['45.181.64.0', '45.181.67.255'],
  ['45.182.56.0', '45.182.59.255'],
  ['45.183.24.0', '45.183.27.255'],
  ['45.184.248.0', '45.184.251.255'],
  ['45.185.16.0', '45.185.19.255'],
  ['45.186.116.0', '45.186.119.255'],
  ['45.187.32.0', '45.187.35.255'],
  ['45.188.8.0', '45.188.11.255'],
  ['45.189.0.0', '45.189.3.255'],
  ['45.190.156.0', '45.190.159.255'],
  ['45.192.0.0', '45.192.7.255'],
  ['45.193.72.0', '45.193.75.255'],
  ['45.194.188.0', '45.194.191.255'],
  ['45.195.124.0', '45.195.127.255'],
  ['45.196.60.0', '45.196.63.255'],
  ['45.197.152.0', '45.197.155.255'],
  ['45.198.140.0', '45.198.143.255'],
  ['45.199.64.0', '45.199.67.255'],
  ['45.200.172.0', '45.200.175.255'],
  ['45.201.248.0', '45.201.251.255'],
  ['45.202.76.0', '45.202.79.255'],
  ['45.203.112.0', '45.203.115.255'],
  ['45.204.32.0', '45.204.35.255'],
  ['45.205.184.0', '45.205.187.255'],
  ['45.206.96.0', '45.206.99.255'],
  ['45.207.4.0', '45.207.7.255'],
  ['45.208.60.0', '45.208.63.255'],
  ['45.209.160.0', '45.209.163.255'],
  ['45.210.164.0', '45.210.167.255'],
  ['45.211.152.0', '45.211.155.255'],
  ['45.212.104.0', '45.212.107.255'],
  ['45.213.132.0', '45.213.135.255'],
  ['45.214.228.0', '45.214.231.255'],
  ['45.215.156.0', '45.215.159.255'],
  ['45.216.184.0', '45.216.187.255'],
  ['45.217.104.0', '45.217.107.255'],
  ['45.218.220.0', '45.218.223.255'],
  ['45.219.72.0', '45.219.75.255'],
  ['45.220.16.0', '45.220.19.255'],
  ['45.221.48.0', '45.221.51.255'],
  ['45.222.32.0', '45.222.35.255'],
  ['45.223.88.0', '45.223.91.255'],
  ['45.224.8.0', '45.224.11.255'],
  ['45.225.140.0', '45.225.143.255'],
  ['45.226.16.0', '45.226.19.255'],
  ['45.227.192.0', '45.227.195.255'],
  ['45.228.160.0', '45.228.163.255'],
  ['45.229.40.0', '45.229.43.255'],
  ['45.230.68.0', '45.230.71.255'],
  ['45.231.132.0', '45.231.135.255'],
  ['45.232.200.0', '45.232.203.255'],
  ['45.233.64.0', '45.233.67.255'],
  ['45.234.48.0', '45.234.51.255'],
  ['45.235.116.0', '45.235.119.255'],
  ['45.236.92.0', '45.236.95.255'],
  ['45.237.144.0', '45.237.147.255'],
  ['45.238.100.0', '45.238.103.255'],
  ['45.239.28.0', '45.239.31.255'],
  ['45.240.192.0', '45.240.195.255'],
  ['45.241.92.0', '45.241.95.255'],
  ['45.242.196.0', '45.242.199.255'],
  ['45.243.36.0', '45.243.39.255'],
  ['45.244.56.0', '45.244.59.255'],
  ['45.245.72.0', '45.245.75.255'],
  ['45.246.128.0', '45.246.131.255'],
  ['45.247.8.0', '45.247.11.255'],
  ['45.248.68.0', '45.248.71.255'],
  ['45.249.0.0', '45.249.3.255'],
  ['45.250.152.0', '45.250.155.255'],
  ['45.251.200.0', '45.251.203.255'],
  ['45.252.20.0', '45.252.23.255'],
  ['45.253.84.0', '45.253.87.255'],
  ['45.254.32.0', '45.254.35.255'],
  ['45.255.156.0', '45.255.159.255'],
  ['46.0.0.0', '46.15.255.255'],
  ['46.16.32.0', '46.16.39.255'],
  ['46.16.192.0', '46.16.195.255'],
  ['46.17.4.0', '46.17.7.255'],
  ['46.17.48.0', '46.17.51.255'],
  ['46.18.32.0', '46.18.39.255'],
  ['46.18.72.0', '46.18.75.255'],
  ['46.19.216.0', '46.19.219.255'],
  ['46.20.64.0', '46.20.71.255'],
  ['46.21.160.0', '46.21.167.255'],
  ['46.22.176.0', '46.22.183.255'],
  ['46.22.192.0', '46.22.199.255'],
  ['46.23.80.0', '46.23.87.255'],
  ['46.24.0.0', '46.27.255.255'],
  ['46.28.4.0', '46.28.7.255'],
  ['46.28.36.0', '46.28.39.255'],
  ['46.28.56.0', '46.28.59.255'],
  ['46.29.20.0', '46.29.23.255'],
  ['46.30.176.0', '46.30.183.255'],
  ['46.31.32.0', '46.31.39.255'],
  ['46.31.52.0', '46.31.55.255'],
  ['46.31.112.0', '46.31.119.255'],
  ['46.34.0.0', '46.34.255.255'],
  ['46.35.32.0', '46.35.39.255'],
  ['46.36.96.0', '46.36.103.255'],
  ['46.37.192.0', '46.37.199.255'],
  ['46.38.176.0', '46.38.183.255'],
  ['46.40.0.0', '46.45.255.255'],
  ['46.48.0.0', '46.55.255.255'],
  ['46.96.0.0', '46.97.255.255'],
  ['46.104.0.0', '46.109.255.255'],
  ['46.144.0.0', '46.145.255.255'],
  ['46.150.0.0', '46.150.255.255'],
  ['46.151.32.0', '46.151.39.255'],
  ['46.166.128.0', '46.166.191.255'],
  ['46.180.0.0', '46.180.255.255'],
  ['46.182.128.0', '46.182.191.255'],
  ['46.183.72.0', '46.183.75.255'],
  ['46.187.0.0', '46.187.255.255'],
  ['46.209.0.0', '46.215.255.255'],
  ['46.226.96.0', '46.226.103.255'],
  ['46.227.32.0', '46.227.39.255'],
  ['46.229.104.0', '46.229.111.255'],
  ['46.229.168.0', '46.229.175.255'],
  ['46.231.24.0', '46.231.27.255'],
  ['46.231.44.0', '46.231.47.255'],
  ['46.235.32.0', '46.235.39.255'],
  ['46.239.0.0', '46.239.255.255'],
  ['46.240.0.0', '46.255.255.255'],
  ['62.12.128.0', '62.12.191.255'],
  ['62.16.0.0', '62.16.255.255'],
  ['62.28.0.0', '62.28.255.255'],
  ['62.32.0.0', '62.32.255.255'],
  ['62.41.0.0', '62.41.255.255'],
  ['62.44.96.0', '62.44.111.255'],
  ['62.45.0.0', '62.45.255.255'],
  ['62.48.0.0', '62.48.255.255'],
  ['62.50.0.0', '62.50.31.255'],
  ['62.51.0.0', '62.51.255.255'],
  ['62.58.0.0', '62.59.255.255'],
  ['62.60.0.0', '62.64.255.255'],
  ['62.65.0.0', '62.65.255.255'],
  ['62.66.0.0', '62.67.255.255'],
  ['62.68.32.0', '62.68.63.255'],
  ['62.69.160.0', '62.69.175.255'],
  ['62.70.0.0', '62.71.255.255'],
  ['62.72.0.0', '62.77.255.255'],
  ['62.77.128.0', '62.77.159.255'],
  ['62.78.0.0', '62.78.127.255'],
  ['62.84.32.0', '62.84.39.255'],
  ['62.84.224.0', '62.84.231.255'],
  ['62.85.0.0', '62.87.39.255'],
  ['62.88.0.0', '62.93.255.255'],
  ['62.94.0.0', '62.94.255.255'],
  ['62.100.0.0', '62.100.31.255'],
  ['62.101.0.0', '62.101.255.255'],
  ['62.102.0.0', '62.111.255.255'],
  ['62.112.32.0', '62.112.39.255'],
  ['62.112.160.0', '62.112.167.255'],
  ['62.116.0.0', '62.127.255.255'],
  ['62.128.0.0', '62.145.39.255'],
  ['62.145.32.0', '62.145.39.255'],
  ['62.148.0.0', '62.159.255.255'],
  ['62.160.0.0', '62.207.255.255'],
  ['62.208.0.0', '62.219.255.255'],
  ['62.220.0.0', '62.255.255.255'],
  ['77.61.0.0', '77.61.255.255'],
  ['77.72.144.0', '77.72.151.255'],
  ['77.73.64.0', '77.73.71.255'],
  ['77.73.224.0', '77.73.231.255'],
  ['77.74.56.0', '77.74.59.255'],
  ['77.74.200.0', '77.74.207.255'],
  ['77.75.64.0', '77.75.71.255'],
  ['77.76.0.0', '77.87.255.255'],
  ['77.87.160.0', '77.87.167.255'],
  ['77.89.0.0', '77.95.255.255'],
  ['77.96.0.0', '77.127.255.255'],
  ['77.128.0.0', '77.175.255.255'],
  ['77.176.0.0', '77.247.255.255'],
  ['77.248.0.0', '77.255.255.255'],
  ['78.20.0.0', '78.21.255.255'],
  ['78.23.128.0', '78.23.255.255'],
  ['78.24.0.0', '78.31.255.255'],
  ['78.32.0.0', '78.47.255.255'],
  ['78.108.32.0', '78.108.39.255'],
  ['78.108.128.0', '78.108.135.255'],
  ['78.109.16.0', '78.109.31.255'],
  ['78.110.0.0', '78.110.255.255'],
  ['78.129.0.0', '78.129.255.255'],
  ['78.136.32.0', '78.136.63.255'],
  ['78.139.0.0', '78.159.255.255'],
  ['78.160.0.0', '78.167.55.255'],
  ['78.168.0.0', '78.255.255.255'],
  ['79.170.80.0', '79.170.87.255'],
  ['79.172.112.0', '79.172.119.255'],
  ['79.98.64.0', '79.98.71.255'],
  ['79.99.0.0', '79.99.255.255'],
  ['79.132.0.0', '79.139.255.255'],
  ['79.140.0.0', '79.175.255.255'],
  ['79.176.0.0', '79.255.255.255'],
  ['80.0.0.0', '80.255.255.255'],
  ['81.0.0.0', '81.255.255.255'],
  ['82.0.0.0', '82.255.255.255'],
  ['83.0.0.0', '83.255.255.255'],
  ['84.0.0.0', '84.255.255.255'],
  ['85.0.0.0', '85.255.255.255'],
  ['86.0.0.0', '86.255.255.255'],
  ['87.0.0.0', '87.255.255.255'],
  ['88.0.0.0', '88.255.255.255'],
  ['89.0.0.0', '89.255.255.255'],
  ['90.0.0.0', '90.255.255.255'],
  ['91.0.0.0', '91.255.255.255'],
  ['92.0.0.0', '92.255.255.255'],
  ['93.0.0.0', '93.255.255.255'],
  ['94.0.0.0', '94.255.255.255'],
  ['95.0.0.0', '95.255.255.255'],
  ['141.138.128.0', '141.138.191.255'],
  ['141.170.0.0', '141.170.255.255'],
  ['141.252.0.0', '141.252.255.255'],
  ['145.0.0.0', '145.255.255.255'],
  ['149.210.0.0', '149.210.255.255'],
  ['151.236.16.0', '151.236.19.255'],
  ['162.208.48.0', '162.208.51.255'],
  ['176.14.0.0', '176.14.255.255'],
  ['178.217.184.0', '178.217.187.255'],
  ['178.224.0.0', '178.239.255.255'],
  ['185.0.0.0', '185.255.255.255'],
  ['188.0.0.0', '188.255.255.255'],
  ['192.87.0.0', '192.87.255.255'],
  ['193.0.0.0', '193.255.255.255'],
  ['194.0.0.0', '194.255.255.255'],
  ['195.0.0.0', '195.255.255.255'],
  ['212.0.0.0', '212.255.255.255'],
  ['213.0.0.0', '213.255.255.255'],
  ['217.0.0.0', '217.255.255.255']
];

/* IPv6-prefixen (compressed, match op eerste N bits). */
const NL_V6_PREFIX = [
  '2a01:', '2a02:', '2a03:', '2a04:', '2a05:', '2a06:', '2a07:',
  '2a08:', '2a09:', '2a10:', '2a11:', '2a12:', '2a13:', '2a14:',
  '2a15:', '2a16:', '2a17:', '2a18:', '2a19:', '2a20:', '2a21:',
  '2a22:', '2a23:', '2a24:', '2a25:', '2a26:', '2a27:', '2a28:',
  '2001:67c:', '2001:678:', '2001:980:', '2001:981:', '2001:982:',
  '2001:983:', '2001:984:', '2001:985:', '2001:990:', '2001:998:',
  '2001:9a8:', '2001:9b0:', '2001:9d8:', '2001:9e0:', '2001:9f0:',
  '2001:1a88:', '2001:1af8:', '2001:1b48:', '2001:1b90:', '2001:1bc8:',
  '2001:1c00:', '2001:1c01:', '2001:1c02:', '2001:1c03:', '2001:1c04:',
  '2001:1c05:', '2001:1c06:', '2001:1c07:', '2001:1c08:', '2001:1c09:',
  '2001:1c10:', '2001:1c18:', '2001:1c20:', '2001:1c28:', '2001:1c30:',
  '2001:1c38:', '2001:1c40:', '2001:1c48:', '2001:1c50:', '2001:1c58:',
  '2001:1c60:', '2001:1c78:', '2001:1c80:', '2001:1c88:', '2001:1c90:',
  '2001:1c98:', '2001:1ca0:', '2001:1ca8:', '2001:1cc0:', '2001:1cc8:',
  '2001:1cd0:', '2001:1cd8:', '2001:1ce0:', '2001:1ce8:', '2001:1cf0:',
  '2001:1cf8:', '2001:4478:', '2001:44a8:', '2001:4548:', '2001:45c8:',
  '2001:4648:', '2001:46c8:', '2001:4830:', '2001:4870:', '2001:48b8:',
  '2001:48f0:', '2001:4970:', '2001:49b0:', '2001:4ac8:', '2001:4af8:',
  '2001:4b90:', '2001:4bc8:', '2001:4c48:', '2001:4d48:', '2001:4dc8:',
  '2001:818:', '2001:820:', '2001:821:', '2001:822:', '2001:828:',
  '2001:838:', '2001:840:', '2001:848:', '2001:850:', '2001:858:',
  '2001:860:', '2001:868:', '2001:870:', '2001:878:', '2001:888:',
  '2001:890:', '2001:898:', '2001:8a0:', '2001:8a8:', '2001:8b0:',
  '2001:8b8:', '2001:8c0:', '2001:8c8:', '2001:8d0:', '2001:8d8:',
  '2001:8e0:', '2001:8e8:', '2001:8f0:', '2001:8f8:', '2001:960:',
  '2001:968:', '2001:970:', '2001:978:', '2001:980:', '2001:988:',
  '2001:990:', '2001:998:', '2001:9a0:', '2001:9a8:', '2001:9b0:',
  '2001:9b8:', '2001:9c0:', '2001:9c8:', '2001:9d0:', '2001:9d8:',
  '2001:9e0:', '2001:9e8:', '2001:9f0:', '2001:9f8:'
];

/* ip -> 32-bit int */
function ip4ToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) { return NaN; }
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const v = parseInt(p[i], 10);
    if (!(v >= 0 && v <= 255)) { return NaN; }
    n = n * 256 + v;
  }
  return n;
}

/* Gesorteerde lijst met binaire zoekmogelijkheid. */
const NL_V4_SORTED = NL_V4
  .map(function (r) { return [ip4ToInt(r[0]), ip4ToInt(r[1])]; })
  .filter(function (r) { return isFinite(r[0]) && isFinite(r[1]); })
  .sort(function (a, b) { return a[0] - b[0]; });

function isNLIPv4(ip) {
  const n = ip4ToInt(ip);
  if (!isFinite(n)) { return false; }
  let lo = 0, hi = NL_V4_SORTED.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (n < NL_V4_SORTED[mid][0]) { hi = mid - 1; }
    else if (n > NL_V4_SORTED[mid][1]) { lo = mid + 1; }
    else { return true; }
  }
  return false;
}

function isNLIPv6(ip) {
  const lower = ip.toLowerCase();
  return NL_V6_PREFIX.some(function (p) { return lower.indexOf(p) === 0; });
}

function isNL(ip) {
  if (!ip) { return false; }
  return ip.indexOf(':') > -1 ? isNLIPv6(ip) : isNLIPv4(ip);
}

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '');
  if (xf) {
    const first = xf.split(',')[0].trim();
    if (first) { return first; }
  }
  const xr = String(req.headers['x-real-ip'] || '').trim();
  if (xr) { return xr; }
  return (req.socket && req.socket.remoteAddress) || '';
}

function isBot(req) {
  return BOT_RE.test(String(req.headers['user-agent'] || ''));
}

/* True = verzoek moet de whitepage zien. ?land=1 omzeilt de cloaker
   (handig voor tests en voor het delen van de echte pagina). */
function wantsWhitepage(req) {
  let q = '';
  try { q = (new URL(req.url, 'http://localhost')).search; } catch (e) { q = ''; }
  if (/(^|[?&])land=1(&|$)/.test(q)) { return false; }

  const ua = String(req.headers['user-agent'] || '');
  if (!ua) { return true; }              // lege UA -> voorzichtig, whitepage
  if (isBot(req)) { return true; }       // bot/ad-reviewer -> whitepage
  return !isNL(clientIp(req));           // geen NL-IP -> whitepage
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
    sendJson(res, 200, {
      ok: true,
      uptime: process.uptime(),
      ip: clientIp(req),
      nl: isNL(clientIp(req)),
      bot: isBot(req)
    });
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

    /* Cloaker: alleen de landingspagina wordt afgeschermd. Bots en
       niet-NL-bezoekers krijgen whitepage.html, met dezelfde response-
       status zodat de uitkomst er hetzelfde uitziet. */
    if (isIndex && ext === '.html' && wantsWhitepage(req)) {
      fs.readFile(WHITEPAGE_FILE, function (err2, white) {
        if (err2) {
          // geen whitepage aanwezig -> normaal gedrag
          serveIndexPayload(req, res, file, ext, data);
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        res.end(white);
      });
      return;
    }

    serveIndexPayload(req, res, file, ext, data);
  });
}

/* Bestaat alleen om de code hierboven leesbaar te houden. */
function serveIndexPayload(req, res, file, ext, data) {
  let payload = data;

  if (ext === '.html' && file.toLowerCase() === INDEX_FILE.toLowerCase()) {
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
