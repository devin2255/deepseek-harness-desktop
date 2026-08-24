!include "nsDialogs.nsh"
!include "LogicLib.nsh"

Var DshCloseTarget

!ifdef BUILD_UNINSTALLER
  Var DshDeleteUserData
  Var DshCleanupToken
!else
  Var DshOldInstallLocation
  Var DshOldAppExe
  Var DshDesktopShortcut
  Var DshStartMenuShortcut
  Var DshLaunchAtLogin
  Var DshDesktopControl
  Var DshStartMenuControl
  Var DshLoginControl
!endif

!define DSH_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define DSH_RUN_VALUE "DeepSeek Harness"
!define DSH_CLOSE_POLL_ATTEMPTS 20
!define DSH_CLOSE_POLL_INTERVAL_MS 500

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro DshInitializeChoices
  StrCpy $DshDesktopShortcut "1"
  StrCpy $DshStartMenuShortcut "1"
  StrCpy $DshLaunchAtLogin "0"

  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "DshDesktopShortcut"
  ${if} $0 == "0"
  ${orIf} $0 == "1"
    StrCpy $DshDesktopShortcut $0
  ${endif}
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "DshStartMenuShortcut"
  ${if} $0 == "0"
  ${orIf} $0 == "1"
    StrCpy $DshStartMenuShortcut $0
  ${endif}
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "DshLaunchAtLogin"
  ${if} $0 == "0"
  ${orIf} $0 == "1"
    StrCpy $DshLaunchAtLogin $0
  ${endif}
!macroend

!macro customInit
  StrCpy $DshOldInstallLocation ""
  StrCpy $DshOldAppExe ""
  ReadRegStr $DshOldInstallLocation HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${if} $DshOldInstallLocation != ""
    StrCpy $DshOldAppExe "$DshOldInstallLocation\${APP_EXECUTABLE_FILENAME}"
  ${endif}
  ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${if} $0 != ""
    InitPluginsDir
    File /oname=$PLUGINSDIR\dsh-compare-semver.ps1 "${BUILD_RESOURCES_DIR}\compare-semver.ps1"
    System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_INSTALLED_VERSION", w "$0") i.r1'
    System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_CANDIDATE_VERSION", w "${VERSION}") i.r1'
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -File $\"$PLUGINSDIR\dsh-compare-semver.ps1$\"`
    Pop $1
    Pop $2
    System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_INSTALLED_VERSION", p 0) i.r1'
    System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_CANDIDATE_VERSION", p 0) i.r1'
    ${if} $1 != "0"
      MessageBox MB_OK|MB_ICONSTOP "The installed DeepSeek Harness SemVer is invalid or could not be checked. Setup will stop without replacing it."
      Quit
    ${endif}
    ${if} $2 == "1"
      MessageBox MB_OK|MB_ICONSTOP "A newer DeepSeek Harness version ($0) is already installed. Downgrade is not allowed."
      Quit
    ${endif}
  ${endif}
  !insertmacro DshInitializeChoices
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

!macro DshRemoveOwnedShortcut Shortcut OldTarget NewTarget
  System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_SHORTCUT", w "${Shortcut}") i.r1'
  System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_OLD_TARGET_EXE", w "${OldTarget}") i.r1'
  System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_NEW_TARGET_EXE", w "${NewTarget}") i.r1'
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -File $\"$PLUGINSDIR\dsh-inspect-shortcut.ps1$\"`
  Pop $0
  Pop $1
  System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_SHORTCUT", p 0) i.r1'
  System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_OLD_TARGET_EXE", p 0) i.r1'
  System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_NEW_TARGET_EXE", p 0) i.r1'
  ${if} $0 == "0"
  ${andIf} $1 == "owned"
    WinShell::UninstShortcut "${Shortcut}"
    Delete "${Shortcut}"
  ${endif}
!macroend

!macro DshRemoveOwnedRunValue OldTarget NewTarget
  ReadRegStr $0 HKCU "${DSH_RUN_KEY}" "${DSH_RUN_VALUE}"
  ${if} "${OldTarget}" != ""
  ${andIf} $0 == '$\"${OldTarget}$\"'
    DeleteRegValue HKCU "${DSH_RUN_KEY}" "${DSH_RUN_VALUE}"
  ${elseIf} "${NewTarget}" != ""
  ${andIf} $0 == '$\"${NewTarget}$\"'
    DeleteRegValue HKCU "${DSH_RUN_KEY}" "${DSH_RUN_VALUE}"
  ${endif}
!macroend

!macro customInstall
  InitPluginsDir
  File /oname=$PLUGINSDIR\dsh-inspect-shortcut.ps1 "${BUILD_RESOURCES_DIR}\inspect-shortcut.ps1"
  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "DshDesktopShortcut" "$DshDesktopShortcut"
  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "DshStartMenuShortcut" "$DshStartMenuShortcut"
  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "DshLaunchAtLogin" "$DshLaunchAtLogin"
  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"

  ${if} $DshDesktopShortcut == ${BST_CHECKED}
    CreateShortcut "$DESKTOP\DeepSeek Harness.lnk" "$appExe" "" "$appExe" 0
    WinShell::SetLnkAUMI "$DESKTOP\DeepSeek Harness.lnk" "${APP_ID}"
  ${else}
    !insertmacro DshRemoveOwnedShortcut "$DESKTOP\DeepSeek Harness.lnk" "$DshOldAppExe" "$appExe"
  ${endif}

  ${if} $DshStartMenuShortcut == ${BST_CHECKED}
    CreateDirectory "$SMPROGRAMS\DeepSeek Harness"
    CreateShortcut "$SMPROGRAMS\DeepSeek Harness\DeepSeek Harness.lnk" "$appExe" "" "$appExe" 0
    WinShell::SetLnkAUMI "$SMPROGRAMS\DeepSeek Harness\DeepSeek Harness.lnk" "${APP_ID}"
  ${else}
    !insertmacro DshRemoveOwnedShortcut "$SMPROGRAMS\DeepSeek Harness\DeepSeek Harness.lnk" "$DshOldAppExe" "$appExe"
    RMDir "$SMPROGRAMS\DeepSeek Harness"
  ${endif}

  !insertmacro DshRemoveOwnedRunValue "$DshOldAppExe" "$appExe"
  ${if} $DshLaunchAtLogin == ${BST_CHECKED}
    WriteRegStr HKCU "${DSH_RUN_KEY}" "${DSH_RUN_VALUE}" '$\"$appExe$\"'
  ${endif}
!macroend

!macro customUnInstallSection
  Section /o "Delete user data (%APPDATA%\DeepSeek Harness)" un.DshDeleteUserData
  SectionEnd
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    InitPluginsDir
    File /oname=$PLUGINSDIR\dsh-inspect-shortcut.ps1 "${BUILD_RESOURCES_DIR}\inspect-shortcut.ps1"
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
      StrCpy $1 "0"
      ClearErrors
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-delete-user-data=$DshCleanupToken' $0
      IfErrors 0 +2
      StrCpy $1 "1"
      System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_UNINSTALL_CLEANUP_TOKEN", p 0) i.r1'
      StrCmp $1 "1" DshCleanupFailed
      StrCmp $0 "0" DshCleanupSkip
      DshCleanupFailed:
      MessageBox MB_RETRYCANCEL|MB_ICONSTOP "DeepSeek Harness could not delete user data. Retry or cancel uninstall; data has not been reported as deleted." /SD IDCANCEL IDRETRY DshCleanupAttempt
      Abort
      DshCleanupSkip:
    ${endif}

    !insertmacro DshRemoveOwnedShortcut "$DESKTOP\DeepSeek Harness.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    !insertmacro DshRemoveOwnedShortcut "$SMPROGRAMS\DeepSeek Harness\DeepSeek Harness.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    RMDir "$SMPROGRAMS\DeepSeek Harness"
    !insertmacro DshRemoveOwnedRunValue "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${endif}
!macroend

!macro DshQueryInstalledProcess Target ExitCode Status
  System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_TARGET_EXE", w "${Target}") i.r1'
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -File $\"$PLUGINSDIR\dsh-query-process.ps1$\"`
  Pop ${ExitCode}
  Pop ${Status}
  System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_TARGET_EXE", p 0) i.r1'
!macroend

!macro customCheckAppRunning
  DshCloseRetry:
  InitPluginsDir
  File /oname=$PLUGINSDIR\dsh-query-process.ps1 "${BUILD_RESOURCES_DIR}\query-installed-process.ps1"
  !ifdef BUILD_UNINSTALLER
  StrCpy $DshCloseTarget "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  !else
  StrCpy $DshCloseTarget "$DshOldAppExe"
  ${if} $DshOldAppExe == ""
    StrCpy $DshCloseTarget "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${endif}
  !endif
  StrCpy $1 0
  DshCloseWait:
  !insertmacro DshQueryInstalledProcess "$DshCloseTarget" $0 $3
  StrCmp $0 "0" 0 DshQueryFailed
  StrCmp $3 "stopped" DshNotRunning
  StrCmp $3 "running" 0 DshQueryFailed
  IntCmp $1 0 DshRequestClose DshAfterCloseRequest DshAfterCloseRequest
  DshRequestClose:
  System::Call 'kernel32::OpenMutexW(i 0x00100000, i 0, w "Local\DeepSeekHarnessDesktop-5e7c4c1c-7429-5bb9-9c22-4e1bf4e2e478") p.r2'
  ${if} $2 != 0
    System::Call 'kernel32::CloseHandle(p r2)'
  ${endif}
  IfFileExists "$DshCloseTarget" 0 DshAfterCloseRequest
  ClearErrors
  Exec '"$DshCloseTarget" --installer-request-close'
  IfErrors DshCloseBlocked
  DshAfterCloseRequest:
  Sleep ${DSH_CLOSE_POLL_INTERVAL_MS}
  IntOp $1 $1 + 1
  IntCmp $1 ${DSH_CLOSE_POLL_ATTEMPTS} DshCloseBlocked DshCloseWait DshCloseBlocked
  DshQueryFailed:
  MessageBox MB_RETRYCANCEL|MB_ICONSTOP "Setup could not query the exact DeepSeek Harness process path. Retry or cancel without replacing live files." /SD IDCANCEL IDRETRY DshCloseRetry
  Abort
  DshCloseBlocked:
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "DeepSeek Harness is still running. Retry after it closes, or cancel without replacing live files." /SD IDCANCEL IDRETRY DshCloseRetry
  Abort
  DshNotRunning:
!macroend
