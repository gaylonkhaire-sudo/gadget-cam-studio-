; Installs the "Gadget Cam Studio" virtual camera (Windows 11) alongside the app, and removes it on uninstall.
!macro customInstall
  IfFileExists "$INSTDIR\resources\vcam\gcs-vcam.exe" 0 +2
    nsExec::ExecToLog '"$INSTDIR\resources\vcam\gcs-vcam.exe" install'
!macroend

!macro customUnInstall
  IfFileExists "$INSTDIR\resources\vcam\gcs-vcam.exe" 0 +2
    nsExec::ExecToLog '"$INSTDIR\resources\vcam\gcs-vcam.exe" uninstall'
!macroend
