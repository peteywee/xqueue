# XQ-POL-003 — Evidence Before Incident Classification

Status: Proposed
Owner: Top Shelf Service / xqueue owner
Source: Production incident #56 recovery verification

## Policy

A suspected publication failure MUST NOT be classified as a confirmed failure solely from an absent, delayed, partial, or ambiguous observation when authoritative state can reasonably be inspected.

Incident classification must correlate, as applicable:

- current time and scheduled time;
- Worker invocation evidence;
- durable publication state;
- publication events;
- lease/inflight state;
- queue integrity and eligibility;
- external side-effect identifier and read-back.

Allowed classification vocabulary:

- `suspected_failure`
- `confirmed_failure`
- `confirmed_success`
- `indeterminate`

Unknown or conflicting evidence must remain `indeterminate` or `suspected_failure`; it must not be forced into a confirmed state for convenience.

## Required control

A future read-only incident snapshot command must assemble the evidence above and produce a classification without mutating publication state.

## Negative requirement

A later scheduler heartbeat, missing terminal log line, absent UI observation, or operator expectation alone MUST NOT produce `confirmed_failure`.
