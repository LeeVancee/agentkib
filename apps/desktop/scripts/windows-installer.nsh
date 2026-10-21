!ifndef AGENTKIB_WINDOWS_INSTALLER_NSH
!define AGENTKIB_WINDOWS_INSTALLER_NSH

!include "LogicLib.nsh"

!ifdef BUILD_UNINSTALLER
  # The include is loaded before MUI_LANGUAGE defines the language constants.
  LangString agentkibUninstallFilesRemain 1033 "Some installation files could not be removed. Close programs using these files and try uninstalling again."
  LangString agentkibUninstallFilesRemain 2052 "无法删除部分安装文件。请关闭使用这些文件的程序后重新卸载。"
  LangString agentkibUninstallFilesRemain 1028 "無法刪除部分安裝檔案。請關閉使用這些檔案的程式後重新解除安裝。"
  LangString agentkibUninstallFilesRemain 1041 "一部のインストールファイルを削除できませんでした。これらのファイルを使用しているプログラムを終了してから、もう一度アンインストールしてください。"

  # Retain every other language offered by electron-builder's default installer,
  # using English for this application-specific message as its own templates do.
  !macro agentkibUninstallFallback LANGUAGE_ID
    LangString agentkibUninstallFilesRemain ${LANGUAGE_ID} "Some installation files could not be removed. Close programs using these files and try uninstalling again."
  !macroend
  !insertmacro agentkibUninstallFallback 1031 # de-DE
  !insertmacro agentkibUninstallFallback 1036 # fr-FR
  !insertmacro agentkibUninstallFallback 3082 # es-ES
  !insertmacro agentkibUninstallFallback 1042 # ko-KR
  !insertmacro agentkibUninstallFallback 1040 # it-IT
  !insertmacro agentkibUninstallFallback 1043 # nl-NL
  !insertmacro agentkibUninstallFallback 1030 # da-DK
  !insertmacro agentkibUninstallFallback 1053 # sv-SE
  !insertmacro agentkibUninstallFallback 1044 # nb-NO
  !insertmacro agentkibUninstallFallback 1035 # fi-FI
  !insertmacro agentkibUninstallFallback 1049 # ru-RU
  !insertmacro agentkibUninstallFallback 2070 # pt-PT
  !insertmacro agentkibUninstallFallback 1046 # pt-BR
  !insertmacro agentkibUninstallFallback 1045 # pl-PL
  !insertmacro agentkibUninstallFallback 1058 # uk-UA
  !insertmacro agentkibUninstallFallback 1029 # cs-CZ
  !insertmacro agentkibUninstallFallback 1051 # sk-SK
  !insertmacro agentkibUninstallFallback 1038 # hu-HU
  !insertmacro agentkibUninstallFallback 1025 # ar-SA
  !insertmacro agentkibUninstallFallback 1055 # tr-TR
  !insertmacro agentkibUninstallFallback 1054 # th-TH
  !insertmacro agentkibUninstallFallback 1066 # vi-VN

  Function un.agentkibRemoveInstallation
    Push $0
    Push $1
    Push $2

    # GetTickCount subtraction also handles a DWORD wrap during this short
    # interval. The retry budget includes time spent attempting removal.
    System::Call 'kernel32::GetTickCount() i .r0'
    StrCpy $2 $0
    SetOutPath "$TEMP"
    InitPluginsDir

    # RMDir can remove the registered uninstaller before reaching a locked
    # application file. Keep its exact bytes so a failed uninstall can be retried.
    # common.nsh defines UNINSTALL_FILENAME only after this include is loaded.
    System::Call 'kernel32::CopyFileW(w "$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe", w "$PLUGINSDIR\agentkib-uninstaller-backup.exe", i 0) i .r0'
    StrCmp $0 0 agentkib_remove_abort

    agentkib_remove_retry:
      ClearErrors
      RMDir /r "$INSTDIR"
      IfErrors agentkib_remove_wait

      # A failed wildcard enumeration is not proof that the directory is gone.
      # Accept only Win32's exact file/path-not-found results, never access denial.
      System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i .r0 ?e'
      Pop $1
      ${If} $0 == -1
        ${If} $1 == 2
        ${OrIf} $1 == 3
          Goto agentkib_remove_done
        ${EndIf}
      ${EndIf}

    agentkib_remove_wait:
      # RMDir only sets NSIS's error flag. Without an explicit failure, its
      # caller would continue removing the uninstall registration and exit 0.
      System::Call 'kernel32::GetTickCount() i .r0'
      IntOp $1 $0 - $2
      ${If} $1 >= 5000
        Goto agentkib_remove_failed
      ${EndIf}
      IntOp $1 5000 - $1
      ${If} $1 > 250
        StrCpy $1 250
      ${EndIf}
      Sleep $1
      System::Call 'kernel32::GetTickCount() i .r0'
      IntOp $1 $0 - $2
      ${If} $1 >= 5000
        Goto agentkib_remove_failed
      ${EndIf}
      Goto agentkib_remove_retry

    agentkib_remove_failed:
      # Do not overwrite a still-present source (including an in-place launch).
      # CopyFile's exact paths also work when listing the directory is denied.
      System::Call 'kernel32::CopyFileW(w "$PLUGINSDIR\agentkib-uninstaller-backup.exe", w "$INSTDIR\Uninstall ${PRODUCT_FILENAME}.exe", i 1) i .r0 ?e'
      Pop $1
      ${If} $0 == 0
      ${AndIf} $1 != 80
        DetailPrint "Could not restore the uninstall entry (Win32 error $1)."
      ${EndIf}

    agentkib_remove_abort:
      Pop $2
      Pop $1
      Pop $0
      SetErrorLevel 2
      Abort "$(agentkibUninstallFilesRemain)"

    agentkib_remove_done:
      Pop $2
      Pop $1
      Pop $0
  FunctionEnd
!endif

!macro customRemoveFiles
  # Keep electron-builder's atomic upgrade/restore behavior, including the
  # in-place fallback where its source uninstaller can remain in $INSTDIR.
  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "File is busy, aborting: $R0"

      # Attempt to restore previous directory
      Push ""
      Call un.restoreFiles
      Pop $R0

      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${endif}

  ${endif}

  ${if} ${isUpdated}
    SetOutPath $TEMP
    RMDir /r $INSTDIR
  ${else}
    Call un.agentkibRemoveInstallation
  ${endif}
!macroend

!endif
