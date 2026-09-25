$ErrorActionPreference = 'Stop'

$shell = $null
$shortcut = $null
$shellApplication = $null
$shellFolder = $null
$shellItem = $null
$shellLink = $null
$status = 2

function Resolve-DshPathIdentity([string] $path) {
  $fullPath = [IO.Path]::GetFullPath($path)
  if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
    return (Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop).FullName
  }
  return $fullPath
}

function Test-DshAbsolutePath([string] $path) {
  if ([String]::IsNullOrWhiteSpace($path)) { return $false }
  try {
    if (-not [IO.Path]::IsPathRooted($path)) { return $false }
    [void] [IO.Path]::GetFullPath($path)
    return $true
  } catch {
    return $false
  }
}

function Read-DshRawShortcutTarget([string] $path) {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface DshShellLinkW {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int length, IntPtr findData, uint flags);
}

public static class DshRawShortcutTarget {
  public static string Read(string path) {
    object link = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046")));
    try {
      ((IPersistFile)link).Load(path, 0);
      var target = new StringBuilder(260);
      ((DshShellLinkW)link).GetPath(target, target.Capacity, IntPtr.Zero, 4);
      return target.ToString();
    } finally {
      Marshal.FinalReleaseComObject(link);
    }
  }
}

public static class DshStoredShortcutTarget {
  static int ReadUInt16(byte[] bytes, int offset) {
    if (offset < 0 || offset > bytes.Length - 2) throw new InvalidDataException("short Shell link field");
    return BitConverter.ToUInt16(bytes, offset);
  }

  static int ReadUInt32(byte[] bytes, int offset) {
    if (offset < 0 || offset > bytes.Length - 4) throw new InvalidDataException("short Shell link field");
    uint value = BitConverter.ToUInt32(bytes, offset);
    if (value > int.MaxValue) throw new InvalidDataException("oversized Shell link field");
    return (int)value;
  }

  static string ReadTerminated(byte[] bytes, int offset, int end, bool unicode) {
    int width = unicode ? 2 : 1;
    if (offset < 0 || offset >= end || end > bytes.Length) throw new InvalidDataException("invalid Shell link string");
    for (int index = offset; index <= end - width; index += width) {
      if (bytes[index] == 0 && (!unicode || bytes[index + 1] == 0)) {
        return (unicode ? Encoding.Unicode : Encoding.Default).GetString(bytes, offset, index - offset);
      }
    }
    throw new InvalidDataException("unterminated Shell link string");
  }

  static string ReadLinkInfo(byte[] bytes, int offset, int size) {
    int end = checked(offset + size);
    int headerSize = ReadUInt32(bytes, offset + 4);
    if (size < 28 || (headerSize != 28 && (headerSize < 36 || headerSize > size))) {
      throw new InvalidDataException("invalid Shell link information header");
    }
    if ((ReadUInt32(bytes, offset + 8) & 1) == 0) return null;
    int baseOffset = headerSize >= 36 ? ReadUInt32(bytes, offset + 28) : 0;
    int suffixOffset = headerSize >= 36 ? ReadUInt32(bytes, offset + 32) : 0;
    if (baseOffset != 0 && suffixOffset != 0 && baseOffset < size && suffixOffset < size) {
      return ReadTerminated(bytes, offset + baseOffset, end, true)
        + ReadTerminated(bytes, offset + suffixOffset, end, true);
    }
    baseOffset = ReadUInt32(bytes, offset + 16);
    suffixOffset = ReadUInt32(bytes, offset + 24);
    if (baseOffset == 0 || baseOffset >= size || suffixOffset >= size) return null;
    return ReadTerminated(bytes, offset + baseOffset, end, false)
      + ReadTerminated(bytes, offset + suffixOffset, end, false);
  }

  public static string Read(string path) {
    var info = new FileInfo(path);
    if (info.Length > 1048576) throw new InvalidDataException("oversized Shell link");
    byte[] bytes = File.ReadAllBytes(path);
    if (bytes.Length < 76 || ReadUInt32(bytes, 0) != 76) throw new InvalidDataException("invalid Shell link header");
    byte[] identifier = new byte[16];
    Array.Copy(bytes, 4, identifier, 0, 16);
    if (new Guid(identifier) != new Guid("00021401-0000-0000-C000-000000000046")) {
      throw new InvalidDataException("invalid Shell link identifier");
    }
    int flags = ReadUInt32(bytes, 20);
    int offset = 76;
    if ((flags & 1) != 0) offset = checked(offset + 2 + ReadUInt16(bytes, offset));
    if (offset > bytes.Length) throw new InvalidDataException("invalid Shell link target list");
    string linkInfoPath = null;
    if ((flags & 2) != 0) {
      int size = ReadUInt32(bytes, offset);
      if (size > bytes.Length - offset) throw new InvalidDataException("invalid Shell link information size");
      linkInfoPath = ReadLinkInfo(bytes, offset, size);
      offset += size;
    }
    if (!String.IsNullOrEmpty(linkInfoPath) && Path.IsPathRooted(linkInfoPath)) return linkInfoPath;
    bool unicode = (flags & 128) != 0;
    if ((flags & 4) != 0) {
      int count = ReadUInt16(bytes, offset);
      offset = checked(offset + 2 + count * (unicode ? 2 : 1));
      if (offset > bytes.Length) throw new InvalidDataException("invalid Shell link name");
    }
    if ((flags & 8) == 0) return null;
    int relativeCount = ReadUInt16(bytes, offset);
    int relativeStart = offset + 2;
    int relativeBytes = checked(relativeCount * (unicode ? 2 : 1));
    if (relativeBytes > bytes.Length - relativeStart) throw new InvalidDataException("invalid Shell link relative path");
    string relative = (unicode ? Encoding.Unicode : Encoding.Default).GetString(bytes, relativeStart, relativeBytes);
    if (String.IsNullOrWhiteSpace(relative)) return null;
    return Path.GetFullPath(Path.Combine(Path.GetDirectoryName(path), relative));
  }
}
'@
  return [DshRawShortcutTarget]::Read($path)
}

function Read-DshStoredShortcutTarget([string] $path) {
  return [DshStoredShortcutTarget]::Read($path)
}

function Read-DshShellShortcutTarget([string] $path) {
  $script:shellApplication = New-Object -ComObject Shell.Application
  $script:shellFolder = $script:shellApplication.Namespace([IO.Path]::GetDirectoryName($path))
  if ($null -eq $script:shellFolder) { throw 'shortcut directory is unavailable' }
  $script:shellItem = $script:shellFolder.ParseName([IO.Path]::GetFileName($path))
  if ($null -eq $script:shellItem) { throw 'shortcut item is unavailable' }
  $script:shellLink = $script:shellItem.GetLink
  if ($null -eq $script:shellLink) { throw 'shortcut link is unavailable' }
  return $script:shellLink.Path
}

function Read-DshWScriptShortcutTarget([string] $path) {
  $script:shell = New-Object -ComObject WScript.Shell
  $script:shortcut = $script:shell.CreateShortcut($path)
  return $script:shortcut.TargetPath
}

function Read-DshShortcutTarget([string] $path) {
  try {
    $target = Read-DshRawShortcutTarget $path
    if (Test-DshAbsolutePath $target) { return $target }
  } catch {
    # Other Shell readers may still recover a usable target from the link.
  }
  try {
    $target = Read-DshStoredShortcutTarget $path
    if (Test-DshAbsolutePath $target) { return $target }
  } catch {
    # Invalid or unsupported link metadata must not authorize ownership.
  }
  if ($path -match '[^\x00-\x7F]') {
    try { $target = Read-DshShellShortcutTarget $path } catch {
      # A Shell link lookup can fail while WScript can still read its stored target.
      $target = $null
    }
    if (Test-DshAbsolutePath $target) { return $target }
    return Read-DshWScriptShortcutTarget $path
  }
  try {
    $target = Read-DshWScriptShortcutTarget $path
    if (Test-DshAbsolutePath $target) { return $target }
  } catch {
    if ($null -ne $script:shortcut) {
      [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($script:shortcut)
      $script:shortcut = $null
    }
    if ($null -ne $script:shell) {
      [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($script:shell)
      $script:shell = $null
    }
  }
  return Read-DshShellShortcutTarget $path
}

try {
  $shortcutPath = $env:DSH_INSTALLER_SHORTCUT
  $targetPaths = @($env:DSH_INSTALLER_OLD_TARGET_EXE, $env:DSH_INSTALLER_NEW_TARGET_EXE) |
    Where-Object { -not [String]::IsNullOrWhiteSpace($_) }
  if (-not [IO.Path]::IsPathRooted($shortcutPath) -or $targetPaths.Count -eq 0) { throw 'invalid shortcut inputs' }
  if (@($targetPaths | Where-Object { -not [IO.Path]::IsPathRooted($_) }).Count -ne 0) { throw 'invalid target inputs' }
  if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
    $status = 10
  } else {
    $rawShortcutTarget = Read-DshShortcutTarget $shortcutPath
    if (-not (Test-DshAbsolutePath $rawShortcutTarget)) { throw 'shortcut target is not an absolute path' }
    $shortcutTarget = Resolve-DshPathIdentity $rawShortcutTarget
    $owned = @($targetPaths | Where-Object {
      [String]::Equals($shortcutTarget, (Resolve-DshPathIdentity $_), [StringComparison]::OrdinalIgnoreCase)
    }).Count -gt 0
    $status = $(if ($owned) { 0 } else { 11 })
  }
} catch {
  [Console]::Error.Write("inspect-shortcut failed: type=$($_.Exception.GetType().FullName) hresult=$($_.Exception.HResult) message=$($_.Exception.Message)")
  $status = 2
} finally {
  if ($null -ne $shellLink) { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shellLink) }
  if ($null -ne $shellItem) { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shellItem) }
  if ($null -ne $shellFolder) { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shellFolder) }
  if ($null -ne $shellApplication) { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shellApplication) }
  if ($null -ne $shortcut) { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
  if ($null -ne $shell) { [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}
exit $status
