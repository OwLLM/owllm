## Profile sync workflow (single source of truth)

1. Edit profiles in `LLM/profiles/*.json` (see `profiles/PROFILE_SCHEMA.md` for required fields).
2. Regenerate all derived artifacts:
   ```bash
   cd LLM
   python -m core.profile_sync generate
   ```
   This updates:
   - `metadata/compatibility_matrix.json`
   - `metadata/dependencies.json`
   - `metadata/hardware_profiles/*.json`
   - `requirements.txt`
3. To verify without writing, run:
   ```bash
   python scripts/verify_profiles_sync.py
   ```
4. No manual edits to the generated files; they are overwritten by the generator.

Consumers:
- Installers (`smart_installer.py`, `installer_v2.py`) read the generated matrix/manifest.
- UI Requirements tab and environment provisioning read from the generated matrix/`requirements.txt`.
