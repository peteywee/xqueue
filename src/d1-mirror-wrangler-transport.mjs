import {
  compileAuthorityLatestEventReadSql,
  compileAuthorityStateReadSql,
  compileMirrorCompareAndSetSql,
  compileMirrorReadSql,
} from './d1-mirror-sync-sql.mjs';

const TARGETS = Object.freeze({
  production: Object.freeze({
    database: 'xqueue-production',
    config: 'wrangler.jsonc',
  }),
  preview: Object.freeze({
    database: 'xqueue-preview',
    config: 'wrangler.preview.jsonc',
  }),
});

function targetFor(env) {
  const target = TARGETS[env];
  if (!target) {
    throw new TypeError('explicit Wrangler environment must be production or preview');
  }
  return target;
}

function assertRunner(runProcess) {
  if (typeof runProcess !== 'function') {
    throw new TypeError('runProcess injection is required');
  }
}

function normalizeProcessResult(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('Wrangler process returned no structured result');
  }

  const exitCode = result.exitCode ?? result.code;
  if (!Number.isSafeInteger(exitCode)) {
    throw new Error('Wrangler process result must include an integer exitCode');
  }

  return {
    exitCode,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

function processFailureDetail(result) {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  return [stderr, stdout].filter((value) => value.length > 0).join('\n');
}

function parseWranglerJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Wrangler D1 output was not valid JSON');
  }

  const statements = Array.isArray(parsed) ? parsed : [parsed];
  if (statements.length === 0) {
    throw new Error('Wrangler D1 JSON contained no statement results');
  }

  for (const statement of statements) {
    if (!statement || typeof statement !== 'object' || statement.success !== true) {
      throw new Error('Wrangler D1 statement did not report success');
    }
    if (!Array.isArray(statement.results)) {
      throw new Error('Wrangler D1 statement results were missing');
    }
  }

  return statements;
}

function singleStatementRows(stdout) {
  const statements = parseWranglerJson(stdout);
  if (statements.length !== 1) {
    throw new Error('Wrangler D1 command returned an unexpected statement count');
  }
  return statements[0].results;
}

function zeroOrOneRow(rows, label) {
  if (!Array.isArray(rows) || rows.length > 1) {
    throw new Error(`${label} query returned an unexpected row count`);
  }
  return rows[0] ?? null;
}

function buildInvocation({ env, sql }) {
  const target = targetFor(env);
  if (typeof sql !== 'string' || sql.length === 0) {
    throw new TypeError('SQL command must be non-empty');
  }

  return Object.freeze({
    command: 'pnpm',
    args: Object.freeze([
      'wrangler',
      'd1',
      'execute',
      target.database,
      '--config',
      target.config,
      '--remote',
      '--yes',
      '--json',
      '--command',
      sql,
    ]),
  });
}

async function executeSql({ env, sql, runProcess }) {
  assertRunner(runProcess);
  const invocation = buildInvocation({ env, sql });
  const processResult = normalizeProcessResult(await runProcess(invocation));

  if (processResult.exitCode !== 0) {
    const detail = processFailureDetail(processResult);
    throw new Error(
      detail.length > 0
        ? `Wrangler D1 command failed: ${detail}`
        : `Wrangler D1 command failed with exit code ${processResult.exitCode}`,
    );
  }

  return {
    invocation,
    rows: singleStatementRows(processResult.stdout),
  };
}

export function compileWranglerD1Invocation({ env, sql } = {}) {
  return buildInvocation({ env, sql });
}

export function createWranglerD1MirrorTransport({ runProcess } = {}) {
  assertRunner(runProcess);

  return Object.freeze({
    async readAuthority({ env } = {}) {
      const stateResult = await executeSql({
        env,
        sql: compileAuthorityStateReadSql(),
        runProcess,
      });
      const eventResult = await executeSql({
        env,
        sql: compileAuthorityLatestEventReadSql(),
        runProcess,
      });

      return {
        state: zeroOrOneRow(stateResult.rows, 'authority state'),
        latestEvent: zeroOrOneRow(eventResult.rows, 'authority event'),
      };
    },

    async readMirror({ env, key } = {}) {
      const result = await executeSql({
        env,
        sql: compileMirrorReadSql(key),
        runProcess,
      });
      const row = zeroOrOneRow(result.rows, 'mirror');
      return row?.value ?? null;
    },

    async compareAndSetMirror({
      env,
      key,
      expected,
      nextValue,
      authority,
    } = {}) {
      const compiled = compileMirrorCompareAndSetSql({
        key,
        expected,
        nextValue,
        authority,
      });
      const result = await executeSql({
        env,
        sql: compiled.sql,
        runProcess,
      });

      if (result.rows.length > 1) {
        throw new Error('mirror compare-and-set returned an unexpected row count');
      }

      const row = result.rows[0] ?? null;
      return {
        applied: row !== null,
        mode: compiled.mode,
        row,
      };
    },
  });
}
