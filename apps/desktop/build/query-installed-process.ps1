$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
  $target = $env:DSH_INSTALLER_TARGET_EXE
  if ([String]::IsNullOrWhiteSpace($target) -or -not [IO.Path]::IsPathRooted($target)) { exit 2 }
  $running = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $_.ExecutablePath -and [String]::Equals($_.ExecutablePath, $target, [StringComparison]::OrdinalIgnoreCase)
  }).Count -gt 0
  [Console]::Out.Write($(if ($running) { 'running' } else { 'stopped' }))
} catch {
  exit 2
}
