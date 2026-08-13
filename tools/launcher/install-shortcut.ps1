$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$launcherPath = Join-Path $PSScriptRoot 'start-fr.vbs'
$iconPath = Join-Path $repoRoot 'assets\ui\five-realms.ico'
$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutName = -join @(0x4E94, 0x57DF, 0x7EB7, 0x4E89 | ForEach-Object { [char]$_ })
$shortcutPath = Join-Path $desktopPath ($shortcutName + '.lnk')

if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
    throw "Launcher entry was not found: $launcherPath"
}
if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
    throw "Launcher icon was not found: $iconPath"
}
if ([string]::IsNullOrWhiteSpace($desktopPath)) {
    throw 'The current user desktop folder could not be resolved.'
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcherPath
$shortcut.WorkingDirectory = $repoRoot
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Description = 'Launch FiveRealms'
$shortcut.WindowStyle = 7
$shortcut.Save()

Write-Output "Desktop shortcut created: $shortcutPath"
