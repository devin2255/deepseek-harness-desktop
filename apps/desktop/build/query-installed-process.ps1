$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Resolve-DshPathIdentity([string] $path) {
  $fullPath = [IO.Path]::GetFullPath($path)
  if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
    return (Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop).FullName
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
    foreach ($process in $processes) { $process.Dispose() }
  }
  [Console]::Out.Write($(if ($running) { 'running' } else { 'stopped' }))
} catch {
  exit 2
}
