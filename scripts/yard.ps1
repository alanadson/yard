<#
.SYNOPSIS
  Always opens Yard at the latest version of the local code.

.DESCRIPTION
  Stamps a hash of the sources into src-tauri/target. If nothing changed since
  last time, it just launches the executable (~1 s). If it did, it runs the
  front-end build, recompiles the binary on the `release-fast` profile and then
  launches. This is the everyday shortcut: no installation involved, the .exe is
  the repository's own.

.PARAMETER Release
  Compiles on the full `release` profile (LTO, strip). Much slower; use it when
  measuring performance or packaging.

.PARAMETER Installer
  Builds the NSIS installer (`npm run tauri build`) and exits without opening
  the app.

.PARAMETER Force
  Rebuilds even when the stamp is up to date.

.PARAMETER NoLaunch
  Builds and does not open the app.

.PARAMETER Shortcut
  (Re)creates the Desktop and Start Menu shortcuts and exits.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\yard.ps1
#>
[CmdletBinding()]
param(
  [switch]$Release,
  [switch]$Installer,
  [switch]$Force,
  [switch]$NoLaunch,
  [switch]$Shortcut
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$iconPath = Join-Path $root 'src-tauri\icons\icon.ico'
$scriptPath = Join-Path $PSScriptRoot 'yard.ps1'

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Note([string]$msg) { Write-Host "    $msg" -ForegroundColor DarkGray }
function Write-Warn([string]$msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }

function Invoke-Step([string]$label, [scriptblock]$block) {
  Write-Step $label
  & $block
  if ($LASTEXITCODE -ne 0) { throw "$label failed (exit code $LASTEXITCODE)." }
}

function New-YardShortcut([string]$lnkPath) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($lnkPath)
  $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
  $lnk.WorkingDirectory = $root
  $lnk.Description = 'Yard — always opens the latest build of the repository'
  if (Test-Path $iconPath) { $lnk.IconLocation = $iconPath }
  $lnk.Save()
  Write-Note $lnkPath
}

# Hash of everything that goes into the binary. `dist/` is deliberately out: it
# is vite's output and its mtime changes on every build, which would keep the
# stamp from ever matching.
function Get-SourceFingerprint {
  $dirs = @('src', 'src-tauri\src', 'src-tauri\capabilities', 'src-tauri\icons', 'public')
  $loose = @(
    'index.html', 'package.json', 'package-lock.json', 'vite.config.ts',
    'tsconfig.json', 'tsconfig.node.json', 'src-tauri\Cargo.toml',
    'src-tauri\Cargo.lock', 'src-tauri\tauri.conf.json', 'src-tauri\build.rs',
    # the launcher itself goes into the hash: changing the build flags invalidates the stamp
    'scripts\yard.ps1'
  )

  $files = @()
  foreach ($dir in $dirs) {
    $full = Join-Path $root $dir
    if (Test-Path $full) {
      $files += Get-ChildItem -Path $full -Recurse -File |
        Where-Object { $_.Name -notmatch '\.test\.(ts|tsx)$' }
    }
  }
  foreach ($file in $loose) {
    $full = Join-Path $root $file
    if (Test-Path $full) { $files += Get-Item $full }
  }

  $sb = New-Object System.Text.StringBuilder
  foreach ($f in ($files | Sort-Object FullName)) {
    [void]$sb.AppendLine("$($f.FullName)|$($f.Length)|$($f.LastWriteTimeUtc.Ticks)")
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($sb.ToString()))
  return ([System.BitConverter]::ToString($bytes)).Replace('-', '')
}

if ($Shortcut) {
  Write-Step 'Creating shortcuts'
  New-YardShortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Yard.lnk')
  New-YardShortcut (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Yard.lnk')
  exit 0
}

if ($Installer) {
  Write-Step 'NSIS installer (full release build, a few minutes)'
  Push-Location $root
  try {
    Invoke-Step 'tauri build' { & npm run tauri build }
  } finally {
    Pop-Location
  }
  $setup = Get-ChildItem (Join-Path $root 'src-tauri\target\release\bundle\nsis') -Filter '*-setup.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($setup) { Write-Step "Done: $($setup.FullName)" }
  exit 0
}

$profileName = 'release-fast'
if ($Release) { $profileName = 'release' }
$exe = Join-Path $root "src-tauri\target\$profileName\yard.exe"
$stampFile = Join-Path $root "src-tauri\target\.yard-launcher-$profileName"

# Windows locks the .exe while the app is running: here we just lean on Tauri's
# single-instance lock, which brings the existing window to the front.
$running = Get-Process -Name 'yard' -ErrorAction SilentlyContinue
if ($running) {
  Write-Warn 'Yard is already open — close it first if you want to rebuild.'
  if (-not $NoLaunch -and (Test-Path $exe)) { Start-Process -FilePath $exe }
  exit 0
}

$fingerprint = Get-SourceFingerprint
$stamped = ''
if (Test-Path $stampFile) { $stamped = (Get-Content $stampFile -Raw).Trim() }
$stale = $Force -or -not (Test-Path $exe) -or ($stamped -ne $fingerprint)

if ($stale) {
  $started = Get-Date
  Push-Location $root
  try {
    Invoke-Step 'Front-end build (tsc + vite)' { & npm run build }
    # `tauri/custom-protocol` is what separates production from dev in Tauri 2:
    # without it, tauri's build.rs turns on the `dev` cfg and the window goes
    # looking for devUrl (localhost:1420) instead of the embedded dist. The CLI
    # passes the feature behind the scenes; a raw `cargo build` does not.
    Invoke-Step "Compiling the binary ($profileName)" {
      if ($Release) {
        & cargo build --release --features tauri/custom-protocol --manifest-path src-tauri\Cargo.toml
      } else {
        & cargo build --profile release-fast --features tauri/custom-protocol --manifest-path src-tauri\Cargo.toml
      }
    }
    Set-Content -Path $stampFile -Value $fingerprint -Encoding utf8
    $secs = [int]((Get-Date) - $started).TotalSeconds
    Write-Step "Build updated in ${secs}s"
  } catch {
    Pop-Location
    Write-Warn $_.Exception.Message
    if ((Test-Path $exe) -and -not $NoLaunch) {
      Write-Warn 'Opening the previous build — the new changes are NOT in it.'
      Start-Process -FilePath $exe
    }
    exit 1
  }
  Pop-Location
} else {
  Write-Step 'Build is already up to date'
}

if ($NoLaunch) { exit 0 }
Write-Step "Opening $exe"
Start-Process -FilePath $exe -WorkingDirectory $root
