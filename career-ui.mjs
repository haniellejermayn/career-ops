#!/usr/bin/env node

import { createReadStream, existsSync, statSync } from 'fs';
import { createServer } from 'http';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

import {
  UiError,
  addTrackedApplication,
  careerOpsPromptForRecord,
  deleteTrackedRecord,
  loadCareerUiState,
  resolveReadableFile,
  updateTrackedRecord,
} from './career-ui/core.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'career-ui', 'public');
const MAX_BODY_BYTES = 64 * 1024;
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.tex': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function sendError(response, error) {
  const status = error instanceof UiError ? error.status : 500;
  const code = error instanceof UiError ? error.code : 'internal-error';
  if (!(error instanceof UiError)) console.error(error);
  sendJson(response, status, { error: error.message || 'Unexpected error.', code });
}

async function readJsonBody(request) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new UiError(415, 'content-type', 'Requests must use application/json.');
  }
  if (request.headers['x-career-ops-ui'] !== '1') {
    throw new UiError(403, 'request-origin', 'Missing local Career-Ops UI request header.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new UiError(413, 'body-too-large', 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new UiError(400, 'invalid-json', 'Request body must contain valid JSON.');
  }
}

function serveFile(response, path, { cache = false } = {}) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new UiError(404, 'not-found', 'File not found.');
  const stats = statSync(path);
  response.writeHead(200, {
    'Content-Type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stats.size,
    'Cache-Control': cache ? 'public, max-age=300' : 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-src 'self'; object-src 'self'; base-uri 'none'; form-action 'self'",
  });
  createReadStream(path).pipe(response);
}

function staticPath(pathname) {
  if (pathname === '/' || pathname === '/index.html') return join(PUBLIC_DIR, 'index.html');
  const candidate = resolve(PUBLIC_DIR, `.${pathname}`);
  const rel = relative(resolve(PUBLIC_DIR), candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new UiError(404, 'not-found', 'File not found.');
  return candidate;
}

function powershellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function launchPowerShell({ cwd, prompt = '' }) {
  const command = `Set-Location -LiteralPath ${powershellLiteral(resolve(cwd))}; codex${prompt ? ` ${powershellLiteral(prompt)}` : ''}`;
  const child = spawn('powershell.exe', ['-NoExit', '-Command', command], {
    cwd: resolve(cwd),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.on('error', () => {});
  child.unref();
}

export function createCareerUiServer({ root = getCareerOpsRoot(), shellLauncher = launchPowerShell } = {}) {
  return createServer(async (request, response) => {
    try {
      const base = `http://${request.headers.host || '127.0.0.1'}`;
      const url = new URL(request.url || '/', base);

      if (request.method === 'GET' && url.pathname === '/api/state') {
        return sendJson(response, 200, loadCareerUiState(root));
      }
      if (request.method === 'GET' && url.pathname === '/favicon.ico') {
        response.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
        return response.end();
      }
      if (request.method === 'GET' && url.pathname === '/files') {
        const path = resolveReadableFile(root, url.searchParams.get('path'));
        return serveFile(response, path);
      }

      if (request.method === 'POST') {
        const input = await readJsonBody(request);
        if (url.pathname === '/api/records') return sendJson(response, 200, await addTrackedApplication(root, input));
        if (url.pathname === '/api/records/update') return sendJson(response, 200, await updateTrackedRecord(root, input));
        if (url.pathname === '/api/records/delete') return sendJson(response, 200, await deleteTrackedRecord(root, input));
        if (url.pathname === '/api/powershell') {
          const prompt = input.recordId ? careerOpsPromptForRecord(root, input) : '';
          await shellLauncher({ cwd: root, prompt });
          return sendJson(response, 200, { message: prompt ? 'Opened Career-Ops for this job.' : 'Opened PowerShell in Career-Ops.' });
        }
        throw new UiError(404, 'not-found', 'API route not found.');
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new UiError(405, 'method-not-allowed', 'Method not allowed.');
      }
      return serveFile(response, staticPath(url.pathname), { cache: url.pathname !== '/' && url.pathname !== '/index.html' });
    } catch (error) {
      sendError(response, error);
    }
  });
}

function parseCliArgs(args) {
  const options = { host: '127.0.0.1', port: 4310, open: true, root: getCareerOpsRoot() };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--no-open') options.open = false;
    else if (arg === '--host') options.host = args[++index];
    else if (arg === '--port') options.port = Number(args[++index]);
    else if (arg === '--root') options.root = resolve(args[++index]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new UiError(400, 'unknown-flag', `Unknown flag: ${arg}`);
  }
  if (!options.host) throw new UiError(400, 'validation', '--host requires a value.');
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new UiError(400, 'validation', '--port must be an integer from 1 to 65535.');
  }
  return options;
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node career-ui.mjs [--port N] [--host HOST] [--root DIR] [--no-open]\n\nStarts the personal Career-Ops interface on http://127.0.0.1:4310.\nThe default host is loopback-only. No data leaves this machine.`);
    return;
  }
  const server = createCareerUiServer({ root: options.root });
  server.on('error', error => {
    console.error(`career-ui: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(options.port, options.host, () => {
    const url = `http://${options.host}:${options.port}`;
    console.log(`Career-Ops UI: ${url}`);
    console.log(`Data root: ${resolve(options.root)}`);
    console.log('Press Ctrl+C to stop.');
    if (options.open) openBrowser(url);
  });
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error(`career-ui: ${error.message}`);
    process.exitCode = 1;
  });
}
