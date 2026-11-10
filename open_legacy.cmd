@echo off
pushd "%~dp0"
python launch_workbench.py --legacy
if errorlevel 1 pause
popd
