#!/bin/bash
# Check Model Status After Clone
# Run this script after cloning the repository to check which models need downloading

echo "======================================================================"
echo "  LLM Studio - Model Status Check"
echo "======================================================================"
echo ""

cd "$(dirname "$0")/LLM" || exit 1

python3 check_models_after_clone.py

if [ $? -eq 0 ]; then
    echo ""
    echo "All models are complete!"
    echo ""
else
    echo ""
    echo "Some models need to be downloaded."
    echo "See instructions above or check MODEL_MANAGEMENT_GUIDE.md"
    echo ""
fi

