; Installs the "Gadget Cam Studio" virtual camera (Windows 11) alongside the app, and removes it on uninstall.
; Also lets phones on the local network reach the app through Windows Firewall (needed for phone cameras and mics).
!macro customInstall
  IfFileExists "$INSTDIR\resources\vcam\gcs-vcam.exe" 0 +2
    nsExec::ExecToLog '"$INSTDIR\resources\vcam\gcs-vcam.exe" install'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Gadget Cam Studio"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Gadget Cam Studio" dir=in action=allow program="$INSTDIR\${PRODUCT_FILENAME}.exe" enable=yes profile=any'
!macroend

!macro customUnInstall
  IfFileExists "$INSTDIR\resources\vcam\gcs-vcam.exe" 0 +2
    nsExec::ExecToLog '"$INSTDIR\resources\vcam\gcs-vcam.exe" uninstall'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Gadget Cam Studio"'
!macroend
