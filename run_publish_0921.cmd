@echo off 
del C:\1_Git\LocaLLM\owllm-desktop\.cache\publish-detached.exit  
C:\PROGRA~1\Git\bin\bash.exe /c/1_Git/LocaLLM/owllm-desktop/scripts/publish-release.sh 
echo %0% > C:\1_Git\LocaLLM\owllm-desktop\.cache\publish-detached.exit 
