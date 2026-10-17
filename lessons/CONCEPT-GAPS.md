# Concept gaps

Concepts that came out of real failures and that Patrick does not yet know well
enough to teach. Each entry is a study item built from his own work, not from a
syllabus. `Status` records how deep the current understanding goes, and posts
must reflect it.

## Mutation testing (mutation analysis)
Surfaced by: 2026-10-17-xqueue-green-suite-untested-controls
Not in the reference book; the corpus is management, not software. Found in:
Wikipedia, "Mutation testing" (summary). The primary source cited there is
DeMillo, Lipton & Sayward, "Hints on test data selection", IEEE Computer
11(4):34-41, 1978. Not read.
One line: deliberately put small faults into the code and see whether the tests
catch them. A fault no test catches marks code that was never really tested.
Status: owner declared "I don't know" (2026-10-17). Only a summary has been read.
Next: read the Wikipedia article in full, then look at
`test/autonomy/mutation.test.mjs`, where this repo already uses the technique.

## Secondary risk
Surfaced by: 2026-10-17-xqueue-timeout-without-cancellation
In the reference book: The Whole Degree Ch. 20 (summarizing Edwards, Managing
Project Risks, 2nd ed., MGMT440). The glossary defines it as "a risk created
by a risk response". Edwards' own text has not been read.
One line: the fix for one risk creates a new one, and the new one is usually
not on the list.
Status: owner declared "I don't know" (2026-10-17), although queued posts A67
and C5 cover it. Those posts should be reviewed before they go out on
2026-11-10 and 2026-11-12.
Next: read The Whole Degree Ch. 20, "Residual risk" and "Secondary risk", then
reread A67 and C5 to check they say what he would say.
