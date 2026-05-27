# OWLLM Bootstrap

Native install-time launcher. Runs *before* Python is on disk, drives the supervisor (Gemma 4 E2B via llama.cpp) to install OWLLM correctly on whatever hardware the user has.

Full design: [../docs/supervisor/BOOTSTRAP.md](../docs/supervisor/BOOTSTRAP.md)

## Layout (target)

```
bootstrap/
├── bootstrap.exe                       # Go-built native launcher (TBD)
├── runtime/
│   ├── llama-server.exe                # static llama.cpp build (TBD)
│   └── gemma-4-E2B-it-Q4_K_M.gguf      # ~1.5 GB (TBD)
├── recipes/
│   ├── hardware_profiles.json          # cold-start happy paths
│   ├── failure_corpus.jsonl            # fine-tune dataset (built up over time)
│   ├── system_prompt.txt               # supervisor system prompt
│   └── plan.gbnf                       # grammar constraining model output
└── wheels/                             # optional pre-staged wheel cache
```

## Status

Skeleton recipe files only. `bootstrap.exe`, `llama-server.exe`, and the GGUF are not yet bundled — see [../docs/supervisor/FINETUNE.md](../docs/supervisor/FINETUNE.md) Step 1 for the recommended starting task.
