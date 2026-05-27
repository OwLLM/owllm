#!/usr/bin/env python3

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'LLM'))

from LLM.core.model_onboarding import get_onboarding_service
import traceback

# Test onboarding a GPTQ model
onboarding = get_onboarding_service()
model_path = 'LLM/models/TheBloke__deepseek-coder-33B-instruct-GPTQ'
model_id = 'TheBloke/deepseek-coder-33B-instruct-GPTQ'

print('Testing GPTQ model onboarding...')
try:
    result = onboarding.ensure_model_onboarded(
        model_id=model_id,
        base_model_path=model_path,
        log_callback=print
    )
    print(f'Result status: {result["status"]}')
    print(f'Environment key: {result.get("env_key", "None")}')
    if result['status'] == 'READY':
        print('SUCCESS: GPTQ model onboarded successfully!')
        if '--dedicated--' in result.get('env_key', ''):
            print('SUCCESS: Dedicated environment was created!')
        else:
            print('WARNING: Dedicated environment was NOT created')
    else:
        print(f'FAILED: {result}')
except Exception as e:
    print(f'Exception during onboarding: {e}')
    traceback.print_exc()