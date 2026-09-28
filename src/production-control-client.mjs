import { spawn } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';

export function splitSqlStatements(sql) {
  const text = String(sql ?? '');
  const statements = [];
  let current = '';
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1] ?? '';

    if (lineComment) {
      current += char;
      if (char === '\n') lineComment = false;
      continue;
    }

    if (blockComment) {
      current += char;
      if (char === '*' && next === '/') {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        if (next === quote) {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === '-' && next === '-') {
      current += char + next;
      index += 1;
      lineComment = true;
      continue;
    }

    if (char === '/' && next === '*') {
      current += char + next;
      index += 1;
      blockComment = true;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }

    if (char === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (quote || blockComment) {
    throw new Error('SQL text ended inside a quoted string or block comment');
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitReady(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error('production control Worker exited before readiness');
    }
    try {
      const response = await fetch(url + '/ready');
      if (response.ok) {
        const body = await response.json();
        if (body?.ok === true && body?.publicationCapable === false) return body;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }

  throw new Error(
    'production control Worker readiness timed out' +
    (lastError ? ': ' + String(lastError.message ?? lastError) : ''),
  );
}

export class ProductionControlSession {
  constructor({
    expected,
    config = 'wrangler.control.jsonc',
    cwd = process.cwd(),
    startupTimeoutMs = 20_000,
  }) {
    if (!expected || typeof expected !== 'object') {
      throw new Error('expected production mutation guard is required');
    }
    this.expected = Object.freeze({ ...expected });
    this.config = config;
    this.cwd = cwd;
    this.startupTimeoutMs = startupTimeoutMs;
    this.child = null;
    this.url = null;
    this.token = null;
    this.logs = [];
  }

  async start() {
    if (this.child) return this;

    const port = randomInt(20_000, 55_000);
    const token = randomBytes(32).toString('hex');
    const url = 'http://127.0.0.1:' + port;

    const argv = [
      'wrangler',
      'dev',
      '--config',
      this.config,
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--var',
      'XQUEUE_CONTROL_TOKEN:' + token,
      '--log-level',
      'error',
      '--show-interactive-dev-session=false',
    ];

    const child = spawn('pnpm', argv, {
      cwd: this.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.url = url;
    this.token = token;

    const collect = (chunk) => {
      this.logs.push(chunk.toString());
      if (this.logs.length > 100) this.logs.shift();
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    try {
      await waitReady(url, child, this.startupTimeoutMs);
      return this;
    } catch (error) {
      await this.close();
      const detail = this.logs.join('').trim();
      throw new Error(
        (error instanceof Error ? error.message : String(error)) +
        (detail ? '\n' + detail.slice(-4000) : ''),
      );
    }
  }

  async batch(operationKind, sqlOrStatements) {
    if (!this.child || !this.url || !this.token) {
      throw new Error('production control Worker is not started');
    }
    if (this.child.exitCode != null) {
      throw new Error('production control Worker exited unexpectedly');
    }

    const statements = Array.isArray(sqlOrStatements)
      ? sqlOrStatements.flatMap((value) => splitSqlStatements(value))
      : splitSqlStatements(sqlOrStatements);

    if (statements.length === 0) {
      throw new Error('production control mutation batch is empty');
    }

    const response = await fetch(this.url + '/batch', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + this.token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        operationKind,
        expected: this.expected,
        statements,
      }),
    });

    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok !== true) {
      throw new Error(
        'production control batch failed (' + response.status + '): ' +
        String(body?.error ?? 'unknown control error'),
      );
    }
    return body.results ?? [];
  }

  async close() {
    const child = this.child;
    this.child = null;
    this.url = null;
    this.token = null;
    if (!child || child.exitCode != null) return;

    child.kill('SIGTERM');
    const deadline = Date.now() + 2_000;
    while (child.exitCode == null && Date.now() < deadline) {
      await sleep(50);
    }
    if (child.exitCode == null) child.kill('SIGKILL');
  }
}

export async function withProductionControl(options, fn) {
  const session = new ProductionControlSession(options);
  await session.start();
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}
