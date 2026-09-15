!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "${BUILD_RESOURCES_DIR}\powershell-commands.nsh"
!include "${BUILD_RESOURCES_DIR}\uninstall-files.nsh"

Var DshCloseTarget
Var DshCloseE2eMode
Var DshCloseE2eRoot
Var DshCloseE2eOwnership
Var DshE2eMode
Var DshAutomationSeen
Var DshRequestedDesktopShortcut
Var DshRequestedStartMenuShortcut
Var DshRequestedAutostart
Var DshRequestedLaunch
Var DshRequestedDeleteUserData
Var DshShortcutLeaf
Var DshStartMenuDirectory
Var DshRunValue

!ifdef BUILD_UNINSTALLER
  Var DshDeleteUserData
  Var DshCleanupToken
!else
  Var DshE2eDefaultInstall
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
!define DSH_CLOSE_POLL_ATTEMPTS 20
!define DSH_CLOSE_POLL_INTERVAL_MS 500

!macro DshE2eTrace Message
  ${If} $DshE2eMode == "1"
    Push $9
    FileOpen $9 "$TEMP\dsh-installer-e2e.log" a
    FileSeek $9 0 END
    FileWrite $9 "${Message}$\r$\n"
    FileClose $9
    Pop $9
  ${EndIf}
!macroend

!macro DshWriteE2eUninstallResult Result
  ${If} $DshE2eMode == "1"
    Push $9
    FileOpen $9 "$TEMP\dsh-uninstaller-e2e-result.txt" w
    FileWrite $9 "${Result}$\r$\n"
    FileClose $9
    Pop $9
  ${EndIf}
!macroend

!macro DshReadAutomationBoolean Name Destination
  ClearErrors
  ${GetOptions} $R0 "/${Name}=" $R1
  ${IfNot} ${Errors}
    StrCpy $DshAutomationSeen "1"
    ${If} $R1 == "0"
    ${OrIf} $R1 == "1"
      StrCpy ${Destination} $R1
    ${Else}
      Goto DshRejectAutomation
    ${EndIf}
  ${EndIf}
!macroend

!macro DshReadAutomationOptions
  StrCpy $DshE2eMode "0"
  StrCpy $DshAutomationSeen "0"
  StrCpy $DshRequestedDesktopShortcut ""
  StrCpy $DshRequestedStartMenuShortcut ""
  StrCpy $DshRequestedAutostart ""
  StrCpy $DshRequestedLaunch ""
  StrCpy $DshRequestedDeleteUserData ""
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/DSH_E2E=" $R1
  ${IfNot} ${Errors}
    StrCpy $DshAutomationSeen "1"
    ${If} $R1 == "1"
      StrCpy $DshE2eMode "1"
    ${Else}
      Goto DshRejectAutomation
    ${EndIf}
  ${EndIf}
  !insertmacro DshReadAutomationBoolean DESKTOPSHORTCUT $DshRequestedDesktopShortcut
  !insertmacro DshReadAutomationBoolean STARTMENUSHORTCUT $DshRequestedStartMenuShortcut
  !insertmacro DshReadAutomationBoolean AUTOSTART $DshRequestedAutostart
  !insertmacro DshReadAutomationBoolean LAUNCH $DshRequestedLaunch
  !insertmacro DshReadAutomationBoolean DELETEUSERDATA $DshRequestedDeleteUserData
  ${If} $DshAutomationSeen == "1"
  ${AndIf} $DshE2eMode != "1"
    Goto DshRejectAutomation
  ${EndIf}
  Goto DshAutomationAccepted
  DshRejectAutomation:
  SetErrorLevel 2
  MessageBox MB_OK|MB_ICONSTOP "Deterministic installer options require /DSH_E2E=1 and Boolean values 0 or 1." /SD IDOK
  Quit
  DshAutomationAccepted:
  ClearErrors
  !insertmacro DshE2eTrace "automation accepted"
!macroend

!macro DshConfigureOwnedIntegrationNames
  StrCpy $DshShortcutLeaf "DeepSeek Harness.lnk"
  StrCpy $DshStartMenuDirectory "DeepSeek Harness"
  StrCpy $DshRunValue "DeepSeek Harness"
  ${If} $DshE2eMode == "1"
    ${GetFileName} "$INSTDIR" $R2
    StrCpy $DshShortcutLeaf "DeepSeek Harness E2E - $R2.lnk"
    StrCpy $DshStartMenuDirectory "DeepSeek Harness E2E - $R2"
    StrCpy $DshRunValue "DeepSeek Harness E2E - $R2"
  ${EndIf}
!macroend

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
  !insertmacro DshReadAutomationOptions
  ${If} $DshE2eMode == "1"
    ReadEnvStr $DshE2eDefaultInstall "DSH_INSTALLER_E2E_DEFAULT_INSTALL"
    ${If} $DshE2eDefaultInstall != ""
      StrCpy $INSTDIR $DshE2eDefaultInstall
    ${EndIf}
  ${EndIf}
  !insertmacro DshConfigureOwnedIntegrationNames
  StrCpy $DshOldInstallLocation ""
  StrCpy $DshOldAppExe ""
  ReadRegStr $DshOldInstallLocation HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${if} $DshOldInstallLocation != ""
    StrCpy $DshOldAppExe "$DshOldInstallLocation\${APP_EXECUTABLE_FILENAME}"
  ${endif}
  ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${if} $0 != ""
    Push $9
    System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_INSTALLED_VERSION", w "$0") i.r9'
    Pop $9
    Push $9
    System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_CANDIDATE_VERSION", w "${VERSION}") i.r9'
    Pop $9
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Restricted -EncodedCommand ${DSH_POWERSHELL_COMPARE_SEMVER}`
    Pop $1
    Pop $2
    Push $9
    System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_INSTALLED_VERSION", p 0) i.r9'
    Pop $9
    Push $9
    System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_CANDIDATE_VERSION", p 0) i.r9'
    Pop $9
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
  ${If} $DshRequestedDesktopShortcut != ""
    StrCpy $DshDesktopShortcut $DshRequestedDesktopShortcut
  ${EndIf}
  ${If} $DshRequestedStartMenuShortcut != ""
    StrCpy $DshStartMenuShortcut $DshRequestedStartMenuShortcut
  ${EndIf}
  ${If} $DshRequestedAutostart != ""
    StrCpy $DshLaunchAtLogin $DshRequestedAutostart
  ${EndIf}
  !insertmacro DshE2eTrace "choices desktop=$DshDesktopShortcut start-menu=$DshStartMenuShortcut autostart=$DshLaunchAtLogin launch=$DshRequestedLaunch"
  !insertmacro DshE2eTrace "custom init complete"
!macroend

!macro customUnInit
  !insertmacro DshReadAutomationOptions
  !insertmacro DshConfigureOwnedIntegrationNames
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
  Push $9
  System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_SHORTCUT", w "${Shortcut}") i.r9'
  Pop $9
  Push $9
  System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_OLD_TARGET_EXE", w "${OldTarget}") i.r9'
  Pop $9
  Push $9
  System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_NEW_TARGET_EXE", w "${NewTarget}") i.r9'
  Pop $9
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Restricted -EncodedCommand ${DSH_POWERSHELL_INSPECT_SHORTCUT}`
  Pop $0
  Pop $1
  !insertmacro DshE2eTrace "shortcut inspect exit=$0 path=${Shortcut} old=${OldTarget} new=${NewTarget}"
  Push $9
  System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_SHORTCUT", p 0) i.r9'
  Pop $9
  Push $9
  System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_OLD_TARGET_EXE", p 0) i.r9'
  Pop $9
  Push $9
  System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_NEW_TARGET_EXE", p 0) i.r9'
  Pop $9
  ${if} $0 == "0"
    WinShell::UninstShortcut "${Shortcut}"
    Delete "${Shortcut}"
  ${endif}
!macroend

!macro DshRemoveOwnedRunValue OldTarget NewTarget
  ReadRegStr $0 HKCU "${DSH_RUN_KEY}" "$DshRunValue"
  ${if} "${OldTarget}" != ""
  ${andIf} $0 == '$\"${OldTarget}$\"'
    DeleteRegValue HKCU "${DSH_RUN_KEY}" "$DshRunValue"
  ${elseIf} "${NewTarget}" != ""
  ${andIf} $0 == '$\"${NewTarget}$\"'
    DeleteRegValue HKCU "${DSH_RUN_KEY}" "$DshRunValue"
  ${endif}
!macroend

!macro customInstall
  !insertmacro DshE2eTrace "custom install entered"
  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "DshDesktopShortcut" "$DshDesktopShortcut"
  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "DshStartMenuShortcut" "$DshStartMenuShortcut"
  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "DshLaunchAtLogin" "$DshLaunchAtLogin"
  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
  ${if} $DshE2eMode == "1"
    WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "DshInstallerE2eRoot" "$INSTDIR"
    WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" "DshInstallerE2eRoot" "$INSTDIR"
  ${endif}

  ${if} $DshDesktopShortcut == ${BST_CHECKED}
    CreateShortcut "$DESKTOP\$DshShortcutLeaf" "$appExe" "" "$appExe" 0
    WinShell::SetLnkAUMI "$DESKTOP\$DshShortcutLeaf" "${APP_ID}"
  ${else}
    !insertmacro DshRemoveOwnedShortcut "$DESKTOP\$DshShortcutLeaf" "$DshOldAppExe" "$appExe"
  ${endif}

  ${if} $DshStartMenuShortcut == ${BST_CHECKED}
    CreateDirectory "$SMPROGRAMS\$DshStartMenuDirectory"
    CreateShortcut "$SMPROGRAMS\$DshStartMenuDirectory\$DshShortcutLeaf" "$appExe" "" "$appExe" 0
    WinShell::SetLnkAUMI "$SMPROGRAMS\$DshStartMenuDirectory\$DshShortcutLeaf" "${APP_ID}"
  ${else}
    !insertmacro DshRemoveOwnedShortcut "$SMPROGRAMS\$DshStartMenuDirectory\$DshShortcutLeaf" "$DshOldAppExe" "$appExe"
    RMDir "$SMPROGRAMS\$DshStartMenuDirectory"
  ${endif}

  !insertmacro DshRemoveOwnedRunValue "$DshOldAppExe" "$appExe"
  ${if} $DshLaunchAtLogin == ${BST_CHECKED}
    WriteRegStr HKCU "${DSH_RUN_KEY}" "$DshRunValue" '$\"$appExe$\"'
  ${endif}
  ${if} $DshE2eMode == "1"
  ${andIf} $DshRequestedLaunch == "1"
    ReadEnvStr $R2 "DSH_INSTALLER_E2E_ROOT"
    ReadEnvStr $R3 "DSH_INSTALLER_E2E_OWNERSHIP"
    Exec '"$appExe" --dsh-installer-e2e-root="$R2" --dsh-installer-e2e-ownership="$R3"'
  ${endif}
  !insertmacro DshE2eTrace "custom install complete"
!macroend

!macro customUnInstallSection
  Section /o "Delete user data (%APPDATA%\DeepSeek Harness)" un.DshDeleteUserData
  SectionEnd
  !insertmacro DshUninstallFileFunctions
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; electron-builder's template owns section 0; customUnInstallSection appends this sole option as section 1.
    ${if} $DshE2eMode == "1"
      StrCpy $DshDeleteUserData $DshRequestedDeleteUserData
      ${if} $DshDeleteUserData == ""
        StrCpy $DshDeleteUserData "0"
      ${endif}
    ${else}
      SectionGetFlags 1 $DshDeleteUserData
      IntOp $DshDeleteUserData $DshDeleteUserData & ${SF_SELECTED}
    ${endif}
    ${if} $DshDeleteUserData == "1"
      ${if} $DshE2eMode == "1"
        Goto DshCleanupAttempt
      ${endif}
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "Permanently delete all user data at $APPDATA\DeepSeek Harness? This cannot be undone." /SD IDNO IDYES DshCleanupAttempt IDNO DshCleanupSkip
      DshCleanupAttempt:
      nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "$$b=New-Object byte[] 32;$$rng=[Security.Cryptography.RandomNumberGenerator]::Create();try{$$rng.GetBytes($$b)}finally{$$rng.Dispose()};$$token=[Convert]::ToBase64String($$b).TrimEnd('=').Replace('+','-').Replace('/','_');[Console]::Out.Write($$token)"`
      Pop $0
      Pop $DshCleanupToken
      StrCmp $0 "0" 0 DshCleanupFailed
      StrLen $1 $DshCleanupToken
      StrCmp $1 "43" 0 DshCleanupFailed
      Push $9
      System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_UNINSTALL_CLEANUP_TOKEN", w "$DshCleanupToken") i.r9'
      Pop $9
      StrCpy $1 "0"
      ClearErrors
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-delete-user-data=$DshCleanupToken' $0
      IfErrors 0 +2
      StrCpy $1 "1"
      !insertmacro DshE2eTrace "cleanup child launch-error=$1 exit=$0"
      Push $9
      System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_UNINSTALL_CLEANUP_TOKEN", p 0) i.r9'
      Pop $9
      StrCmp $1 "1" DshCleanupFailed
      StrCmp $0 "0" DshCleanupSkip
      DshCleanupFailed:
      !insertmacro DshWriteE2eUninstallResult "cleanup-rejected"
      SetErrorLevel 2
      MessageBox MB_RETRYCANCEL|MB_ICONSTOP "DeepSeek Harness could not delete user data. Retry or cancel uninstall; data has not been reported as deleted." /SD IDCANCEL IDRETRY DshCleanupAttempt
      Abort
      DshCleanupSkip:
    ${endif}

    !insertmacro DshRemoveOwnedShortcut "$DESKTOP\$DshShortcutLeaf" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    !insertmacro DshRemoveOwnedShortcut "$SMPROGRAMS\$DshStartMenuDirectory\$DshShortcutLeaf" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    RMDir "$SMPROGRAMS\$DshStartMenuDirectory"
    !insertmacro DshRemoveOwnedRunValue "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    !insertmacro DshWriteE2eUninstallResult "uninstall-accepted"
  ${endif}
!macroend

!macro DshQueryInstalledProcess Target ExitCode Status
  Push $9
  System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_TARGET_EXE", w "${Target}") i.r9'
  Pop $9
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Restricted -EncodedCommand ${DSH_POWERSHELL_QUERY_INSTALLED_PROCESS}`
  Pop ${ExitCode}
  Pop ${Status}
  !insertmacro DshE2eTrace "process query exit=${ExitCode} status=${Status}"
  Push $9
  System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_TARGET_EXE", p 0) i.r9'
  Pop $9
!macroend

!macro customCheckAppRunning
  DshCloseRetry:
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
  ReadEnvStr $DshCloseE2eMode "DSH_INSTALLER_E2E"
  ${If} $DshCloseE2eMode == "1"
    ReadEnvStr $DshCloseE2eRoot "DSH_INSTALLER_E2E_ROOT"
    ReadEnvStr $DshCloseE2eOwnership "DSH_INSTALLER_E2E_OWNERSHIP"
    ClearErrors
    Exec '"$DshCloseTarget" --installer-request-close "--dsh-installer-e2e-root=$DshCloseE2eRoot" "--dsh-installer-e2e-ownership=$DshCloseE2eOwnership"'
  ${Else}
    ClearErrors
    Exec '"$DshCloseTarget" --installer-request-close'
  ${EndIf}
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
  !insertmacro DshE2eTrace "application process stopped"
!macroend
