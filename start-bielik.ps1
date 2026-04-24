param(
    [string]$Workspace = "",
    [int]$Port = 8088,
    [int]$Context = 8192,
    [int]$GpuLayers = 99,
    [switch]$ServerOnly
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($Workspace)) {
    $Workspace = Join-Path $Root "workspace"
}

$Workspace = [System.IO.Path]::GetFullPath($Workspace)
$ModelConfigPath = Join-Path $Root "config\model.json"
if (Test-Path $ModelConfigPath) {
    $ModelConfig = Get-Content $ModelConfigPath -Raw | ConvertFrom-Json
    $Model = Join-Path $Root $ModelConfig.file
    $ModelName = $ModelConfig.serverModel
    $Context = [int]$ModelConfig.contextTokens
    $GpuLayers = [int]$ModelConfig.gpuLayers
} else {
    $Model = Join-Path $Root "models\qwen2.5-coder-14b-instruct-q4_k_m.gguf"
    $ModelName = "qwen2.5-coder-14b-instruct-q4_k_m"
}
$Agent = Join-Path $Root "scripts\bielik_agent.py"
$Logs = Join-Path $Root "logs"

New-Item -ItemType Directory -Force -Path $Workspace, $Logs | Out-Null

if (!(Test-Path $Model)) {
    throw "Model file not found: $Model"
}
if (!(Test-Path $Agent)) {
    throw "Agent script not found: $Agent"
}

$ServerExe = Get-ChildItem -Path (Join-Path $Root "runtime") -Recurse -Filter "llama-server.exe" -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
if (!$ServerExe) {
    throw "llama-server.exe not found under runtime\. Extract llama.cpp first."
}

function Test-ServerReady {
    param([int]$ServerPort)
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$ServerPort/v1/models" -TimeoutSec 2 | Out-Null
        return $true
    } catch {
        return $false
    }
}

$StartedServer = $false
$ServerProcess = $null

if (!(Test-ServerReady -ServerPort $Port)) {
    $ServerLogOut = Join-Path $Logs "llama-server.out.log"
    $ServerLogErr = Join-Path $Logs "llama-server.err.log"

    $ServerArgs = @(
        "-m", $Model,
        "-c", "$Context",
        "-ngl", "$GpuLayers",
        "--host", "127.0.0.1",
        "--port", "$Port",
        "--jinja"
    )

    Write-Host "Starting local model server on http://127.0.0.1:$Port ..."
    $ServerProcess = Start-Process -FilePath $ServerExe `
        -ArgumentList $ServerArgs `
        -WorkingDirectory (Split-Path -Parent $ServerExe) `
        -RedirectStandardOutput $ServerLogOut `
        -RedirectStandardError $ServerLogErr `
        -PassThru `
        -WindowStyle Hidden
    $StartedServer = $true

    $Ready = $false
    foreach ($i in 1..120) {
        Start-Sleep -Seconds 1
        if ($ServerProcess.HasExited) {
            throw "llama-server exited early. Check logs\llama-server.err.log"
        }
        if (Test-ServerReady -ServerPort $Port) {
            $Ready = $true
            break
        }
    }
    if (!$Ready) {
        throw "llama-server did not become ready within 120 seconds. Check logs\llama-server.err.log"
    }
} else {
    Write-Host "Using existing server on http://127.0.0.1:$Port ..."
}

if ($ServerOnly) {
    Write-Host "Server is ready. Press Ctrl+C to stop if this process owns it."
    while ($true) { Start-Sleep -Seconds 3600 }
}

try {
    Write-Host "Sandbox root: $Workspace"
    Write-Host "Type /exit to quit."
    & python $Agent --workspace $Workspace --base-url "http://127.0.0.1:$Port/v1" --model $ModelName
} finally {
    if ($StartedServer -and $ServerProcess -and !$ServerProcess.HasExited) {
        Write-Host "Stopping local model server ..."
        Stop-Process -Id $ServerProcess.Id -Force
    }
}
