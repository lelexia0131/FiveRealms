$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$gameUrl = 'http://127.0.0.1:8000/'
$port = 8000
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$mutex = $null
$ownsMutex = $false
$result = 0

function Show-ErrorMessage([string] $message) {
    try {
        $shell = New-Object -ComObject WScript.Shell
        [void] $shell.Popup($message, 0, 'FiveRealms launcher', 16)
    }
    catch {
        Write-Error $message
    }
}

function Test-FiveRealmsPage {
    try {
        $response = Invoke-WebRequest -Uri $gameUrl -UseBasicParsing -TimeoutSec 1
        $cacheControl = [string] ($response.Headers['Cache-Control'] -join ',')
        return $response.StatusCode -ge 200 -and
            $response.StatusCode -lt 400 -and
            $response.Content.Contains('<section id="game-screen"') -and
            $response.Content.Contains('<small>FIVE REALMS</small>') -and
            $cacheControl.Contains('no-store')
    }
    catch {
        return $false
    }
}

function Test-PortOpen {
    $client = New-Object Net.Sockets.TcpClient
    $pendingConnection = $null
    try {
        $pendingConnection = $client.BeginConnect('127.0.0.1', $port, $null, $null)
        if (-not $pendingConnection.AsyncWaitHandle.WaitOne(300)) {
            return $false
        }
        $client.EndConnect($pendingConnection)
        return $true
    }
    catch {
        return $false
    }
    finally {
        if ($null -ne $pendingConnection) {
            $pendingConnection.AsyncWaitHandle.Close()
        }
        $client.Close()
    }
}

try {
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'index.html') -PathType Leaf)) {
        throw "FiveRealms index.html was not found at: $repoRoot"
    }

    $mutex = New-Object Threading.Mutex($false, 'Local\FiveRealmsLauncher-127.0.0.1-8000')
    try {
        $ownsMutex = $mutex.WaitOne([TimeSpan]::FromSeconds(10))
    }
    catch [Threading.AbandonedMutexException] {
        $ownsMutex = $true
    }
    if (-not $ownsMutex) {
        throw 'Another FiveRealms launcher is still starting. Please try again in a few seconds.'
    }

    $ready = Test-FiveRealmsPage
    if (-not $ready -and (Test-PortOpen)) {
        # A real FiveRealms server can still be warming up after the TCP listener appears.
        for ($attempt = 0; $attempt -lt 5; $attempt++) {
            Start-Sleep -Milliseconds 200
            if (Test-FiveRealmsPage) {
                $ready = $true
                break
            }
        }
        if (-not $ready) {
            throw "Port 8000 is already in use, but $gameUrl is not the canonical no-cache FiveRealms entry page. Stop the other program or free port 8000, then try again."
        }
    }

    if (-not $ready) {
        $python = Get-Command py.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $python) {
            throw 'Python Launcher (py.exe) was not found. Install Python for Windows with the py launcher, then try again.'
        }

        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = $python.Source
        $startInfo.Arguments = 'tools/dev-server.py --host 127.0.0.1 --port 8000'
        $startInfo.WorkingDirectory = $repoRoot
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
        $server = [Diagnostics.Process]::Start($startInfo)
        if ($null -eq $server) {
            throw 'The Python HTTP server process could not be started.'
        }

        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            if (Test-FiveRealmsPage) {
                $ready = $true
                break
            }
            if ($server.HasExited) {
                throw "The Python HTTP server exited before FiveRealms became available (exit code $($server.ExitCode))."
            }
            Start-Sleep -Milliseconds 150
        }

        if (-not $ready) {
            if (-not $server.HasExited) {
                $server.Kill()
            }
            throw "The Python HTTP server started, but $gameUrl did not become available in time."
        }
    }

    # Keep the browser launch in one place so one invocation cannot open multiple tabs itself.
    Start-Process -FilePath $gameUrl
}
catch {
    Show-ErrorMessage $_.Exception.Message
    $result = 1
}
finally {
    if ($ownsMutex) {
        [void] $mutex.ReleaseMutex()
    }
    if ($null -ne $mutex) {
        $mutex.Dispose()
    }
}

exit $result
