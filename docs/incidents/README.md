# XQueue Incidents

This directory contains durable incident records for operational failures,
ambiguous outcomes, recovery events, and other findings that may produce
XQueue fixes or candidate improvements to TSAL.

Incident records should preserve:

- what happened;
- expected behavior;
- observed behavior;
- affected automation/work item;
- side-effect status: yes, no, or unknown;
- durable state before and after;
- root cause;
- failed or missing control;
- recovery procedure;
- verification evidence;
- resulting regression test or control;
- whether the lesson remains XQueue-specific or should be proposed to TSAL.

Do not rewrite or delete incident history merely to restore a healthy state.
