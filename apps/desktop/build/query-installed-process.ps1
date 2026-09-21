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
  $running = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | Where-Object {
    try {
      $_.Path -and [String]::Equals((Resolve-DshPathIdentity $_.Path), $target, [StringComparison]::OrdinalIgnoreCase)
    } catch {
      $false
    }
  }).Count -gt 0
  [Console]::Out.Write($(if ($running) { 'running' } else { 'stopped' }))
} catch {
  exit 2
}
