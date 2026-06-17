param(
  [string]$InstallDir = "$HOME\.webbridge\WebBridge",
  [string]$Repo = "cgarrot/WebBridge",
  [string]$Version = "latest",
  [switch]$NoAutostart,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

function Get-WebBridgeArch {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($arch -eq "ARM64") { return "arm64" }
  if ($arch -eq "AMD64" -or $arch -eq "x86") { return "x64" }
  throw "Unsupported CPU architecture: $arch"
}

function Test-FileContains($Path, $Needle) {
  if (!(Test-Path $Path)) { return $false }
  return ((Get-Content -Raw -Path $Path) -like "*$Needle*")
}

function Test-WebBridgeInstallDir($Path) {
  $manifest = Join-Path $Path "RELEASE-MANIFEST.json"
  $rootPackage = Join-Path $Path "package.json"
  $daemonPackage = Join-Path $Path "packages\daemon\package.json"

  $isRelease = (Test-FileContains $manifest '"schema": "webbridge.release-bundle.v1"') -and
    (Test-FileContains $manifest '"name": "WebBridge"')
  $isSourceCheckout = (Test-FileContains $rootPackage '"name": "webbridge"') -and
    (Test-FileContains $daemonPackage '"name": "@webbridge/daemon"')

  return $isRelease -or $isSourceCheckout
}

function Install-WebBridgeStartupTask($Root) {
  $taskName = "WebBridge Daemon"
  $cmd = Join-Path $Root "bin\webbridge.cmd"
  $action = New-ScheduledTaskAction -Execute $cmd -Argument "serve" -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "WebBridge local browser automation daemon" -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName | Out-Null
}

$arch = Get-WebBridgeArch
$asset = "webbridge-windows-$arch.zip"
if ($Version -eq "latest") {
  $url = "https://github.com/$Repo/releases/latest/download/$asset"
} else {
  $url = "https://github.com/$Repo/releases/download/$Version/$asset"
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("webbridge-install-" + [System.Guid]::NewGuid().ToString("N"))
$archive = Join-Path $temp $asset
$extract = Join-Path $temp "extract"
New-Item -ItemType Directory -Force -Path $temp, $extract | Out-Null

try {
  Write-Host "Downloading WebBridge release bundle: $url"
  try {
    Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
  } catch {
    throw "Could not download a prebuilt WebBridge release asset: $url`nIf this is a new fork or no release exists yet, ask your agent to use the source-build fallback from docs/agent-install.md."
  }

  Expand-Archive -Path $archive -DestinationPath $extract -Force
  $bundle = Join-Path $extract "webbridge"
  $bundleCmd = Join-Path $bundle "bin\webbridge.cmd"
  if (!(Test-Path $bundleCmd)) {
    throw "Invalid release bundle: missing bin\webbridge.cmd"
  }

  if (Test-Path $InstallDir) {
    if (!(Test-WebBridgeInstallDir $InstallDir)) {
      throw "Refusing to replace directory without a WebBridge release/source marker: $InstallDir"
    }
    $existingCmd = Join-Path $InstallDir "bin\webbridge.cmd"
    if (Test-Path $existingCmd) {
      try { & $existingCmd stop | Out-Null } catch {}
    }
  }

  $parent = Split-Path -Parent $InstallDir
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  $staging = Join-Path $parent (".WebBridge.install." + $PID)
  if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
  Copy-Item -Recurse -Force $bundle $staging
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  Move-Item -Force $staging $InstallDir

  $installedCmd = Join-Path $InstallDir "bin\webbridge.cmd"
  $autostartConfigured = $false
  if (!$NoAutostart) {
    try {
      Install-WebBridgeStartupTask $InstallDir
      $autostartConfigured = $true
    } catch {
      Write-Warning "Could not configure Windows startup task; falling back to manual start. $($_.Exception.Message)"
    }
  }

  if (!$NoStart -and !$autostartConfigured) {
    try { & $installedCmd start | Out-Host } catch { Write-Warning "Could not start WebBridge daemon: $($_.Exception.Message)" }
  } elseif (!$NoStart) {
    Start-Sleep -Seconds 1
  }

  Write-Host ""
  Write-Host "WebBridge installed."
  Write-Host ""
  Write-Host "Installed at:"
  Write-Host "  $InstallDir"
  Write-Host ""
  Write-Host "Daemon command:"
  Write-Host "  $installedCmd status"
  Write-Host ""
  Write-Host "Chrome extension folder to load manually:"
  Write-Host "  $(Join-Path $InstallDir "extension")"
  Write-Host ""
  Write-Host "Agent Skill source files:"
  Write-Host "  $(Join-Path $InstallDir "skills\cursor\SKILL.md")"
  Write-Host "  $(Join-Path $InstallDir "skills\claude-code\SKILL.md")"
  Write-Host "  $(Join-Path $InstallDir "skills\codex\SKILL.md")"
  Write-Host "  $(Join-Path $InstallDir "skills\openclaw\SKILL.md")"
  Write-Host ""
  Write-Host "Next Chrome step:"
  Write-Host "  1. Open chrome://extensions"
  Write-Host "  2. Enable Developer mode"
  Write-Host "  3. Click Load unpacked"
  Write-Host "  4. Select: $(Join-Path $InstallDir "extension")"
  Write-Host "  5. Run: $installedCmd status"
  Write-Host ""

  if (!$NoStart) {
    try { & $installedCmd status | Out-Host } catch {}
  }
} finally {
  if (Test-Path $temp) { Remove-Item -Recurse -Force $temp }
}
