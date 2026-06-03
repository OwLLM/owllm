# Security policy

## Reporting a vulnerability

**Do not file a public GitHub Issue for a security vulnerability.**

If you believe you've found a vulnerability in OwLLM Desktop or in any file in this repository, please report it privately:

1. **Preferred:** Use GitHub's [private vulnerability reporting](https://github.com/OwLLM/owllm/security/advisories/new) (Security tab → Report a vulnerability)
2. **Alternative:** Open a private discussion with a maintainer

Please include:
- A description of the issue and its impact
- Steps to reproduce
- Affected versions
- Any proof-of-concept code or screenshots
- Your contact for follow-up

## What we treat as a vulnerability

- **Application binaries:** any code-execution, privilege-escalation, or data-exfiltration path in the OwLLM Desktop application
- **Distribution chain:** any tampering of the install / update mechanism (registry, module ZIPs, latest.json)
- **Data layer:** template / role / profile files whose content could cause the application to behave maliciously when loaded
- **Repository:** workflow privilege escalation, secret exposure

NOT in scope:
- Issues that require physical access AND administrator privileges already
- Self-XSS in your own copy of the application
- Reports that depend on outdated third-party dependencies whose patches are pending upstream (we'll track those but treat them at upstream severity)
- Theoretical issues with no exploit path

## Response targets

- **Acknowledgement:** within 3 business days
- **Triage + severity assessment:** within 7 business days
- **Fix shipped:** within 30 days for high-severity, 90 days for moderate

## Disclosure

Once a fix is available, we coordinate public disclosure with the reporter. Reporters are credited in the release notes and the advisory unless they request otherwise.

## Bug bounty

OwLLM doesn't currently run a paid bounty programme. We do credit reporters publicly and we're considering a bounty programme as the user base grows — feedback welcome via Discussions.
