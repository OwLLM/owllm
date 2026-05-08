# Image used by OWLLM's agents-tab team for containerized CLI calls.
#
# Built automatically on first containerized Run by `core.agents.agent_image`.
# Tag is content-hashed (`owllm/agent:<sha-of-this-file>`), so editing this
# Dockerfile bumps the tag and triggers a rebuild on next Run. Users who
# pinned a custom image in <fleet_root>/runtime.json bypass this entirely.
#
# What's inside:
#   - Node.js 20 (claude-code + codex CLIs are npm packages)
#   - claude-code, codex CLIs preinstalled (npm globals)
#   - Python 3 + pip (the OWLLM shell tool sometimes runs python scripts)
#   - git, curl, ca-certificates (everyday dev needs)
#
# Auth is mounted RO at runtime via default_auth_mounts() — DO NOT bake
# credentials into the image.

FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        curl \
        ca-certificates \
        python3 \
        python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Pinned to majors so a transient registry blip doesn't leave the user
# with a broken image. Bump deliberately.
RUN npm install --omit=dev -g \
        @anthropic-ai/claude-code \
        @openai/codex \
    && npm cache clean --force

WORKDIR /workspace
# Default command is bash so `docker exec` and `docker run …image bash -c …`
# both work without an explicit entrypoint.
CMD ["/bin/bash"]
