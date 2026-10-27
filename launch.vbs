' Hidden launcher for VP Board Better: starts the local server without a console window.
Option Explicit

Dim fso, sh, base, ps1, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = base & "\tools\launch-hidden.ps1"

If Not fso.FileExists(ps1) Then
  MsgBox "Missing tools\launch-hidden.ps1, please re-check the folder.", 16, "VP Board Better"
  WScript.Quit 1
End If

sh.CurrentDirectory = base
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
sh.Run cmd, 0, False
