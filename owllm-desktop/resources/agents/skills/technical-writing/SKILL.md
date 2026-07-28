---
name: Technical Writing
description: How to write clear docs, READMEs, and explanations — structured for the reader, accurate, and free of filler.
---

# Technical Writing

Write so the reader gets what they need fast and trusts it. Clarity over cleverness.

## Know the reader and the job
- Decide who this is for (new user? maintainer? operator?) and what they're trying to do. Write to that.
- Lead with the outcome: what this is, what it does for them, and how to start. Don't bury it under history or caveats.

## Structure
- Put the most useful thing first. Use headings, short paragraphs, and lists so it's scannable.
- One idea per section. If a section sprawls, split it.
- Show, don't just tell: a concrete, **runnable** example beats three paragraphs of description. Make sure the example actually works.
- For procedures, number the steps in the exact order the reader performs them, including the prerequisite and the expected result.

## Accuracy
- Only document what is true of the current code/behaviour. Verify commands, paths, and outputs before you write them — never invent a flag or a result.
- Mark anything provisional, version-specific, or platform-specific as such.
- When you change behaviour, update the docs that describe it in the same breath.

## Voice
- Plain, direct, active voice. Define a term once, then use it consistently.
- Cut filler ("simply", "just", "obviously", "as you know"). If a sentence carries no information, delete it.
- Prefer the specific to the vague: "runs on port 8080" not "runs on a port".

Good docs are short, ordered for the reader, and every line you can check is correct.
