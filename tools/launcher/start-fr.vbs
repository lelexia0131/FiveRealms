Option Explicit

Dim fileSystem, launcherDirectory, powerShellScript, shell, command

Set fileSystem = CreateObject("Scripting.FileSystemObject")
launcherDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
powerShellScript = fileSystem.BuildPath(launcherDirectory, "start-fr.ps1")

If Not fileSystem.FileExists(powerShellScript) Then
    MsgBox "FiveRealms launcher script was not found:" & vbCrLf & powerShellScript, vbCritical, "FiveRealms launcher"
    WScript.Quit 1
End If

Set shell = CreateObject("WScript.Shell")
command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & QuoteArgument(powerShellScript)

On Error Resume Next
shell.Run command, 0, False
If Err.Number <> 0 Then
    MsgBox "PowerShell could not start:" & vbCrLf & Err.Description, vbCritical, "FiveRealms launcher"
    WScript.Quit 1
End If
On Error GoTo 0

Function QuoteArgument(ByVal value)
    QuoteArgument = Chr(34) & value & Chr(34)
End Function
