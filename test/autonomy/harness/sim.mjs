// Deterministic concurrency / crash / fault simulator for Batch 0.
//
// Modeled state only: an in-memory canonical store with CAS generation, leases, idempotency
// identities and an X-like external target. No network, no D1, no R2, no X.
//
// Every actor is driven by the real decide() + transition() from src/autonomy, so this explores
// whether the decision model + FSM keep safety under all interleavings, injected faults and crashes.

import { decide as defaultDecide, DEFAULT_POLICY } from '../../../src/autonomy/decision-model.mjs';
import { transition as defaultTransition, resumeFromCrash } from '../../../src/autonomy/state-machine.mjs';
import { BASELINES } from '../../../src/autonomy/fault-catalog.mjs';
import { ALL_EVIDENCE } from './scenarios.mjs';

const RETRY_LIMIT = 2;
const DEFER_LIMIT = 2;

function initialWorld(config) {
  return {
    store: { generation: 1, records: {}, ops: {}, applyCount: {}, leases: {}, external: {} },
    actors: config.actors.map((a, index) => ({
      id: `A${index}`,
      key: a.key,
      digest: a.digest,
      opId: `op:${a.key}:${a.digest}`,
      item: { state: 'PLANNED', dispatched: false },
      snapshotGen: null,
      casStale: false,
      effect: 'none',
      retries: 0,
      defers: 0,
      crashed: false,
      done: false,
      halted: null,
      faults: { ...a.faults },
      trace: [],
    })),
    violations: [],
  };
}

const clone = (value) => structuredClone(value);

function observation(config, actor, patch) {
  const lane = config.lane;
  return {
    ...BASELINES[lane],
    retryBudget: actor.retries < RETRY_LIMIT ? 'available' : 'exhausted',
    ...patch,
  };
}

function step(world, actorIndex, choice, config, engine) {
  const w = clone(world);
  const a = w.actors[actorIndex];
  const s = w.store;
  const decide = (patch) => engine.decide(observation(config, a, patch), config.policy ?? DEFAULT_POLICY);
  const move = (decision) => {
    const t = engine.transition(a.item, {
      type: decision.outcome, actor: 'automation', evidence: ALL_EVIDENCE, retryTarget: decision.retryTarget ?? undefined,
    });
    a.trace.push(`${a.item.state}-${decision.outcome}(${decision.primaryReason})->${t.ok ? t.to : `REJECT:${t.reason}`}`);
    if (!t.ok) {
      w.violations.push(`${a.id}: FSM rejected ${decision.outcome} from ${a.item.state}: ${t.reason}`);
      a.done = true;
      return;
    }
    a.item = { ...t.item };
    if (t.to === 'HALTED') a.halted = decision.primaryReason;
  };
  const releaseLease = () => { if (s.leases[a.key] === a.id) delete s.leases[a.key]; };

  switch (a.item.state) {
    case 'PLANNED': {
      // Fresh read of canonical state + lease attempt, as one atomic step.
      a.snapshotGen = s.generation;
      const existing = s.records[a.key];
      const conflicting = existing && existing.digest !== a.digest;
      const holder = s.leases[a.key];
      let concurrency = 'none';
      if (holder && holder !== a.id) concurrency = 'contended';
      const patch = {
        concurrency,
        readback: s.ops[a.opId] ? 'proves_applied' : 'proves_not_applied',
        input: conflicting ? 'conflicting' : 'valid',
      };
      const d = decide(patch);
      if (d.outcome === 'AUTO_RESOLVE') s.leases[a.key] = a.id;
      move(d);
      break;
    }
    case 'EXECUTING': {
      if (choice === 'crash_before_dispatch') {
        // Crash before the request leaves: resume treats it as possibly dispatched anyway.
        a.item = { ...resumeFromCrash(a.item).item };
        a.effect = 'ambiguous';
        a.crashed = true;
        a.trace.push('CRASH(before dispatch)->VERIFYING');
        break;
      }
      const fault = a.faults.dispatch ?? 'none';
      a.faults.dispatch = 'none'; // faults fire once
      const casOk = s.generation === a.snapshotGen && !s.ops[a.opId];
      a.casStale = s.generation !== a.snapshotGen;
      let applied = false;
      if (fault !== 'fail_before_write' && casOk) {
        applied = true;
        if (config.lane === 'publication') {
          s.external[a.key] = (s.external[a.key] ?? 0) + 1;
        }
        s.records[a.key] = { digest: a.digest, opId: a.opId };
        s.ops[a.opId] = true;
        s.applyCount[a.opId] = (s.applyCount[a.opId] ?? 0) + 1;
        s.generation += 1;
      }
      if (choice === 'crash_after_dispatch') {
        a.item = { ...resumeFromCrash(a.item).item };
        a.effect = 'ambiguous';
        a.crashed = true;
        a.trace.push(`CRASH(after dispatch, applied=${applied})->VERIFYING`);
        break;
      }
      if (fault === 'drop_response') a.effect = 'ambiguous';
      else if (applied) a.effect = 'success';
      else a.effect = 'failure_transient'; // explicit: CAS conflict or write rejected before apply
      const t = engine.transition(a.item, { type: 'DISPATCH_RETURNED', actor: 'automation', evidence: ALL_EVIDENCE });
      a.trace.push(`EXECUTING-DISPATCH_RETURNED(${a.effect})->${t.to}`);
      a.item = { ...t.item };
      break;
    }
    case 'VERIFYING': {
      const fault = a.faults.verify ?? 'none';
      a.faults.verify = 'none';
      let readback = s.ops[a.opId] ? 'proves_applied' : 'proves_not_applied';
      if (fault === 'readback_unavailable') readback = 'unavailable';
      const holder = s.leases[a.key];
      const d = decide({
        effect: a.effect,
        readback,
        concurrency: holder && holder !== a.id ? 'lease_lost' : 'none',
        versionFence: a.effect === 'failure_transient' && a.casStale ? 'stale_runtime' : 'current',
      });
      move(d);
      if (['COMPLETE', 'RETRY_WAIT', 'DEFERRED', 'QUARANTINED'].includes(a.item.state)) releaseLease();
      a.effect = a.item.state === 'HALTED' ? a.effect : 'none';
      break;
    }
    case 'RETRY_WAIT': {
      a.retries += 1;
      const t = engine.transition(a.item, { type: 'RETRY_READY', actor: 'automation', evidence: ALL_EVIDENCE });
      a.trace.push(`RETRY_WAIT-RETRY_READY->${t.to}`);
      a.item = { ...t.item };
      break;
    }
    case 'DEFERRED': {
      if (a.defers >= DEFER_LIMIT) { a.done = true; a.trace.push('DEFERRED(parked)'); break; }
      a.defers += 1;
      const t = engine.transition(a.item, { type: 'DEFER_ELAPSED', actor: 'automation', evidence: ALL_EVIDENCE });
      a.trace.push(`DEFERRED-DEFER_ELAPSED->${t.to}`);
      a.item = { ...t.item };
      break;
    }
    default:
      a.done = true;
  }
  if (['COMPLETE', 'IGNORED', 'DISCARDED', 'HALTED', 'QUARANTINED'].includes(a.item.state)) a.done = true;
  checkSafety(w, config);
  return w;
}

function checkSafety(w, config) {
  for (const [opId, count] of Object.entries(w.store.applyCount)) {
    if (count > 1) w.violations.push(`duplicate canonical apply for ${opId} (${count})`);
  }
  for (const [key, count] of Object.entries(w.store.external)) {
    if (count > 1) w.violations.push(`duplicate external effect for ${key} (${count})`);
  }
  for (const a of w.actors) {
    if (a.item.state === 'COMPLETE' && !w.store.ops[a.opId]) w.violations.push(`${a.id} COMPLETE without applied evidence`);
    if (a.item.state === 'IGNORED' && !w.store.ops[a.opId]) w.violations.push(`${a.id} IGNORED but nothing applied its identity`);
  }
  void config;
}

function key(world) {
  return JSON.stringify([world.store, world.actors.map((a) => [a.item, a.effect, a.retries, a.defers, a.done, a.faults, a.snapshotGen])]);
}

// Explore every interleaving (and optional crash points) as a state graph with memoization.
export function explore(config, engine = { decide: defaultDecide, transition: defaultTransition }) {
  const start = initialWorld(config);
  const seen = new Set();
  const stack = [start];
  const terminals = [];
  let states = 0;
  const violations = new Set();
  while (stack.length) {
    const w = stack.pop();
    const k = key(w);
    if (seen.has(k)) continue;
    seen.add(k);
    states += 1;
    for (const v of w.violations) violations.add(v);
    const live = w.actors.map((a, i) => (a.done ? -1 : i)).filter((i) => i >= 0);
    if (live.length === 0) { terminals.push(w); continue; }
    for (const i of live) {
      stack.push(step(w, i, 'normal', config, engine));
      if (config.crashes && w.actors[i].item.state === 'EXECUTING' && !w.actors[i].crashed) {
        stack.push(step(w, i, 'crash_before_dispatch', config, engine));
        stack.push(step(w, i, 'crash_after_dispatch', config, engine));
      }
    }
    if (states > 500000) throw new Error('state explosion guard');
  }
  return { states, terminals, violations: [...violations] };
}

export function terminalSummary(result) {
  const endStates = {};
  for (const w of result.terminals) {
    const sig = w.actors.map((a) => `${a.item.state}${a.halted ? `(${a.halted})` : ''}`).join(',');
    endStates[sig] = (endStates[sig] ?? 0) + 1;
  }
  return endStates;
}

export const DISPATCH_FAULTS = Object.freeze(['none', 'drop_response', 'fail_before_write']);
export const VERIFY_FAULTS = Object.freeze(['none', 'readback_unavailable']);
