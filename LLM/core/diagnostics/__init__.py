"""Diagnostics — tools that turn 'something broke' into 'here is what the system looked like'.

First module: :mod:`core.diagnostics.snapshot` — a one-shot dump of OWLLM
state (DBs, configs, logs, processes, agent-runtime probe results) into
a portable zip the user can share for offline analysis.

Why this exists
---------------

When a user reports a bug that surfaces only at runtime (a goal stuck in
RUNNING, an agent container exiting cleanly but with the wrong output,
the orchestrator forgetting the goal mid-session), the maintainer needs
the running state — which DBs have what rows, which processes are alive,
what's in the bus log, which agent definitions were loaded — to repro.
Asking the user to run six different commands and paste the output is
fragile and slow. ``python -m core.diagnostics.snapshot`` produces one
zip with everything.

Privacy
-------

The snapshot may contain user-typed goals (which the user could have
typed an API key into), bot tokens, file paths under ``%USERPROFILE%``,
and similar. By default the snapshotter redacts plain-text files
(JSON / YAML / log) using a conservative regex set; SQLite databases
are included verbatim with a manifest warning so the user can inspect
before sharing. Use ``--no-redact`` to skip redaction (e.g. for a
trusted local replay) or ``--no-dbs`` for the strictest privacy.
"""
