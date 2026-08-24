!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WordFunc.nsh"
!insertmacro VersionCompare

!ifdef BUILD_UNINSTALLER
  Var DshDeleteUserData
  Var DshCleanupToken
!else
  Var DshDesktopShortcut
  Var DshStartMenuShortcut
  Var DshLaunchAtLogin
  Var DshDesktopControl
  Var DshStartMenuControl
  Var DshLoginControl
!endif

!define DSH_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define DSH_RUN_VALUE "DeepSeek Harness"

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInit
  ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${if} $0 != ""
    ${VersionCompare} "$0" "${VERSION}" $1
    ${if} $1 == "1"
      MessageBox MB_OK|MB_ICONSTOP "A newer DeepSeek Harness version ($0) is already installed. Downgrade is not allowed."
      Quit
    ${endif}
  ${endif}
  StrCpy $DshDesktopShortcut "1"
  StrCpy $DshStartMenuShortcut "1"
  StrCpy $DshLaunchAtLogin "0"
  ${if} ${isUpdated}
    ReadRegStr $DshDesktopShortcut HKCU "${INSTALL_REGISTRY_KEY}" "DshDesktopShortcut"
    ReadRegStr $DshStartMenuShortcut HKCU "${INSTALL_REGISTRY_KEY}" "DshStartMenuShortcut"
    ReadRegStr $DshLaunchAtLogin HKCU "${INSTALL_REGISTRY_KEY}" "DshLaunchAtLogin"
  ${endif}
!macroend

!macro customPageAfterChangeDir
  Page custom DshOptionsCreate DshOptionsLeave
!macroend

!ifndef BUILD_UNINSTALLER
Function DshOptionsCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 18u "Choose optional integrations. You can change these choices during an update or repair."
  Pop $0
  ${NSD_CreateCheckbox} 0 28u 100% 12u "Create a desktop shortcut"
  Pop $DshDesktopControl
  ${NSD_SetState} $DshDesktopControl $DshDesktopShortcut
  ${NSD_CreateCheckbox} 0 48u 100% 12u "Add DeepSeek Harness to the Start menu"
  Pop $DshStartMenuControl
  ${NSD_SetState} $DshStartMenuControl $DshStartMenuShortcut
  ${NSD_CreateCheckbox} 0 68u 100% 12u "Start DeepSeek Harness when I sign in"
  Pop $DshLoginControl
  ${NSD_SetState} $DshLoginControl $DshLaunchAtLogin
  nsDialogs::Show
FunctionEnd

Function DshOptionsLeave
  ${NSD_GetState} $DshDesktopControl $DshDesktopShortcut
  ${NSD_GetState} $DshStartMenuControl $DshStartMenuShortcut
  ${NSD_GetState} $DshLoginControl $DshLaunchAtLogin
FunctionEnd
!endif

!macro customInstall
  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "DshDesktopShortcut" "$DshDesktopShortcut"
  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "DshStartMenuShortcut" "$DshStartMenuShortcut"
  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "DshLaunchAtLogin" "$DshLaunchAtLogin"

  ${if} $DshDesktopShortcut == ${BST_CHECKED}
    CreateShortcut "$DESKTOP\DeepSeek Harness.lnk" "$appExe" "" "$appExe" 0
    WinShell::SetLnkAUMI "$DESKTOP\DeepSeek Harness.lnk" "${APP_ID}"
  ${else}
    WinShell::UninstShortcut "$DESKTOP\DeepSeek Harness.lnk"
    Delete "$DESKTOP\DeepSeek Harness.lnk"
  ${endif}

  ${if} $DshStartMenuShortcut == ${BST_CHECKED}
    CreateDirectory "$SMPROGRAMS\DeepSeek Harness"
    CreateShortcut "$SMPROGRAMS\DeepSeek Harness\DeepSeek Harness.lnk" "$appExe" "" "$appExe" 0
    WinShell::SetLnkAUMI "$SMPROGRAMS\DeepSeek Harness\DeepSeek Harness.lnk" "${APP_ID}"
  ${else}
    WinShell::UninstShortcut "$SMPROGRAMS\DeepSeek Harness\DeepSeek Harness.lnk"
    Delete "$SMPROGRAMS\DeepSeek Harness\DeepSeek Harness.lnk"
    RMDir "$SMPROGRAMS\DeepSeek Harness"
  ${endif}

  ${if} $DshLaunchAtLogin == ${BST_CHECKED}
    WriteRegStr HKCU "${DSH_RUN_KEY}" "${DSH_RUN_VALUE}" '$\"$appExe$\"'
  ${else}
    ReadRegStr $0 HKCU "${DSH_RUN_KEY}" "${DSH_RUN_VALUE}"
    ${if} $0 == '$\"$appExe$\"'
      DeleteRegValue HKCU "${DSH_RUN_KEY}" "${DSH_RUN_VALUE}"
    ${endif}
  ${endif}
!macroend

!macro customUnInstallSection
  Section /o "Delete user data (%APPDATA%\DeepSeek Harness)" un.DshDeleteUserData
  SectionEnd
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; electron-builder's template owns section 0; customUnInstallSection appends this sole option as section 1.
    SectionGetFlags 1 $DshDeleteUserData
    IntOp $DshDeleteUserData $DshDeleteUserData & ${SF_SELECTED}
    ${if} $DshDeleteUserData == "1"
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "Permanently delete all user data at $APPDATA\DeepSeek Harness? This cannot be undone." /SD IDNO IDYES DshCleanupAttempt IDNO DshCleanupSkip
      DshCleanupAttempt:
      nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "$$b=New-Object byte[] 32;$$rng=[Security.Cryptography.RandomNumberGenerator]::Create();try{$$rng.GetBytes($$b)}finally{$$rng.Dispose()};$$token=[Convert]::ToBase64String($$b).TrimEnd('=').Replace('+','-').Replace('/','_');[Console]::Out.Write($$token)"`
      Pop $0
      Pop $DshCleanupToken
      StrCmp $0 "0" 0 DshCleanupFailed
      StrLen $1 $DshCleanupToken
      StrCmp $1 "43" 0 DshCleanupFailed
      System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_UNINSTALL_CLEANUP_TOKEN", w "$DshCleanupToken") i.r1'
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-delete-user-data=$DshCleanupToken' $0
      System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_UNINSTALL_CLEANUP_TOKEN", p 0) i.r1'
      StrCmp $0 "0" DshCleanupSkip
      DshCleanupFailed:
      MessageBox MB_RETRYCANCEL|MB_ICONSTOP "DeepSeek Harness could not delete user data. Retry or cancel uninstall; data has not been reported as deleted." /SD IDCANCEL IDRETRY DshCleanupAttempt
      Abort
      DshCleanupSkip:
    ${endif}

    WinShell::UninstShortcut "$DESKTOP\DeepSeek Harness.lnk"
    Delete "$DESKTOP\DeepSeek Harness.lnk"
    WinShell::UninstShortcut "$SMPROGRAMS\DeepSeek Harness\DeepSeek Harness.lnk"
    Delete "$SMPROGRAMS\DeepSeek Harness\DeepSeek Harness.lnk"
    RMDir "$SMPROGRAMS\DeepSeek Harness"
    ReadRegStr $0 HKCU "${DSH_RUN_KEY}" "${DSH_RUN_VALUE}"
    ${if} $0 == '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\"'
      DeleteRegValue HKCU "${DSH_RUN_KEY}" "${DSH_RUN_VALUE}"
    ${endif}
  ${endif}
!macroend

!macro customCheckAppRunning
  DshCloseRetry:
  System::Call 'kernel32::OpenMutexW(i 0x00100000, i 0, w "Local\DeepSeekHarnessDesktop-5e7c4c1c-7429-5bb9-9c22-4e1bf4e2e478") p.r2'
  IntCmp $2 0 DshNotRunning
  System::Call 'kernel32::CloseHandle(p r2)'
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 DshNotRunning
  ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --installer-request-close' $0
  StrCpy $1 0
  DshCloseWait:
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "if ((Get-CimInstance Win32_Process | ? {$$_.ExecutablePath -and $$_.ExecutablePath.Equals('$INSTDIR\${APP_EXECUTABLE_FILENAME}', 'OrdinalIgnoreCase')}).Count) { exit 1 }"`
  Pop $0
  StrCmp $0 "0" DshNotRunning
  Sleep 500
  IntOp $1 $1 + 1
  IntCmp $1 20 DshCloseBlocked DshCloseWait DshCloseBlocked
  DshCloseBlocked:
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "DeepSeek Harness is still running. Retry after it closes, or cancel without replacing live files." /SD IDCANCEL IDRETRY DshCloseRetry
  Abort
  DshNotRunning:
!macroend
