---
name: Debugging Method
description: A systematic way to find the true root cause of a bug — reproduce, isolate, hypothesise, confirm — instead of guessing or patching symptoms.
---

# Debugging Method

When something is broken, resist the urge to guess-and-patch. Work the problem in order.

## 1. Reproduce it
- Get a reliable, minimal way to trigger the bug. If you can't reproduce it, you can't confirm a fix.
- Note the exact inputs, environment, and the precise observed vs. expected behaviour.

## 2. Locate it
- Read the actual error, stack trace, and logs — fully. The answer is usually in there.
- If it worked before and broke now, find the regression first: check recent changes / `git log` before theorising.
- Narrow the surface: bisect, add a targeted log/probe at the boundary, or binary-search the code path. Confirm *where* it goes wrong before deciding *why*.

## 3. Find the root cause
- Form a specific, falsifiable hypothesis ("the value is null here because X"). Then prove or disprove it with evidence — don't assume.
- Keep going until you reach the actual cause, not the first place it surfaces. A null-check at the crash site is a symptom patch; the question is why it was null.

## 4. Fix and confirm
- Make the smallest change that addresses the root cause.
- Re-run your reproduction. The bug must be gone AND you must not have broken anything nearby.
- Remove any temporary probes/logs you added.

## Anti-patterns
- Don't fabricate an explanation that "sounds right" without evidence.
- Don't stack speculative changes hoping one works — change one thing, observe, decide.
- Don't declare it fixed because it "should" work. Declare it fixed because you watched it work.
