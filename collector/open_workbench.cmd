@echo off
pushd "%~dp0"
python launch_workbench.py
if errorlevel 1 pause
popd
