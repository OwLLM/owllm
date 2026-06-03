# OwLLM Desktop — End-User License Agreement

**Effective: 2026-06-03**

This EULA governs your use of the **OwLLM Desktop application binaries** distributed via the GitHub Releases page of this repository. It does NOT apply to the contents of this repository (templates, registry, docs), which are MIT-licensed — see [LICENSE](LICENSE).

## 1. Grant of License

OwLLM grants you a personal, non-exclusive, non-transferable, royalty-free licence to install and use the OwLLM Desktop application on machines you own or control, for personal, educational, research, internal-business, or commercial purposes.

## 2. Restrictions

You may NOT:
- Reverse-engineer, decompile, or disassemble the application beyond what is permitted by applicable law (e.g., for interoperability under EU directives).
- Redistribute the binaries under a different name or with stripped attribution.
- Use OwLLM to host a paid third-party service that resells OwLLM's functionality without prior written agreement (single-tenant self-hosting for your own organisation is fine).

## 3. Data & Privacy

OwLLM is **local-first by design**. The application does not transmit your conversations, prompts, model weights, or fine-tuning data to OwLLM's servers. The application MAY connect to:
- HuggingFace (when you choose to download a model)
- GitHub (for shell + module updates from THIS repository's Releases and `data/` directory)
- Third-party LLM APIs (Anthropic, OpenAI, Google, Moonshot) — only when you provide your own API keys
- MCP servers you explicitly configure

No telemetry is collected by OwLLM. See the in-app **Accounts** page for what credentials are stored and where.

## 4. Third-Party Components

OwLLM Desktop bundles third-party open-source software including [llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT), [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (MIT), [Tauri](https://tauri.app/) (MIT/Apache 2.0), [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (Microsoft EULA), and other components whose licences are reproduced in the application's `LICENSES.txt`. Continued use of OwLLM is subject to the terms of those licences with respect to those components.

## 5. Warranty Disclaimer

THE APPLICATION IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. OwLLM disclaims all warranties of merchantability, fitness for a particular purpose, and non-infringement to the maximum extent permitted by applicable law.

## 6. Limitation of Liability

To the maximum extent permitted by applicable law, in no event shall OwLLM or its contributors be liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of or inability to use the application.

## 7. Termination

This licence terminates automatically if you breach any of its terms. Upon termination, you must cease using the application and delete all copies.

## 8. Updates

The application may automatically download and install updates to itself, its modules, and the data layer (per the mechanisms described in [README.md](README.md) "How updates work"). You may disable auto-updates in the application's Settings.

## 9. Governing Law

This EULA is governed by the laws of the jurisdiction in which OwLLM is established, without regard to its conflict-of-law rules.

## 10. Contact

Questions about this EULA: [open a Discussion](https://github.com/OwLLM/owllm/discussions/categories/q-a) or email the contact listed on the OwLLM organisation profile.
