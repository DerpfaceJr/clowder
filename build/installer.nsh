; Clowder NSIS hooks (electron-builder "nsis.include"). The cats' sandbox needs WSL.
; Nothing is enabled without the owner's Yes. The app's Workshop card offers the same install later.
; UNVERIFIED on a real machine: the exit behaviour of wsl.exe --status and whether Windows asks for a restart.

!macro customInstall
  ; This installer is 32-bit, so System32 is redirected. Sysnative is the real 64-bit System32.
  StrCpy $0 "$WINDIR\Sysnative\wsl.exe"
  IfFileExists "$0" 0 wsl_missing
  nsExec::ExecToStack '"$0" --status'
  Pop $1
  Pop $2
  ${If} $1 == 0
    Goto wsl_done
  ${EndIf}

  wsl_missing:
  MessageBox MB_YESNO|MB_ICONQUESTION "Clowder's cats need Windows Subsystem for Linux for their sandbox. Install it now? (Windows will ask for permission and may need a restart.)" IDYES wsl_install IDNO wsl_done

  wsl_install:
  ; Elevated through the Windows prompt. Clowder never runs this without the Yes above.
  ExecShellWait "runas" "$WINDIR\Sysnative\wsl.exe" "--install --no-distribution" SW_SHOWNORMAL
  MessageBox MB_OK "If Windows asked you to restart, Clowder finishes setting up the cats' workshop the next time it opens after the restart."

  wsl_done:
!macroend
