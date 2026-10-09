$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Resolve-DshPathIdentity([string] $path) {
  $fullPath = [IO.Path]::GetFullPath($path)
  if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
    try {
      return (Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop).FullName
    } catch {
      # Replacement can remove an executable between the existence check and identity lookup.
      return $fullPath
    }
  }
  return $fullPath
}

try {
  $target = $env:DSH_INSTALLER_TARGET_EXE
  if ([String]::IsNullOrWhiteSpace($target) -or -not [IO.Path]::IsPathRooted($target)) { exit 2 }
  $target = Resolve-DshPathIdentity $target
  $processName = [IO.Path]::GetFileNameWithoutExtension($target)
  $running = $false
  $processes = [Diagnostics.Process]::GetProcessesByName($processName)
  try {
    foreach ($process in $processes) {
      try {
        $candidate = $process.MainModule.FileName
        if ($candidate -and [String]::Equals((Resolve-DshPathIdentity $candidate), $target, [StringComparison]::OrdinalIgnoreCase)) {
          $running = $true
          break
        }
      } catch {
        # A process can exit or deny image-path access between enumeration and inspection.
      }
    }
  } finally {
    foreach ($process in $processes) {
      try { $process.Dispose() } catch {
        # A raced process teardown must not turn an exact-path query into an indeterminate result.
      }
    }
  }
  [Console]::Out.Write($(if ($running) { 'running' } else { 'stopped' }))
} catch {
  [Console]::Error.Write("query-installed-process failed: type=$($_.Exception.GetType().FullName) hresult=$($_.Exception.HResult)")
  exit 2
}
