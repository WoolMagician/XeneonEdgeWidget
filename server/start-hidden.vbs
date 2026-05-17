Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
serverPath = scriptDir & "\server.js"
killScriptPath = scriptDir & "\kill-existing.ps1"
shell.CurrentDirectory = scriptDir
shell.Run "cmd /c powershell -NoProfile -ExecutionPolicy Bypass -File """ & killScriptPath & """ ^&^& node """ & serverPath & """", 0, False
