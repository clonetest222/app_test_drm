; Force dong app dang chay khi mo installer -> cho phep cap nhat ghi de file
; (tranh loi "cannot close"). Co tac dung ca khi update tu trong app.
; Dong CA ten cu (G4 Denuvo Tool) lan ten moi (G4play Denuvo Manage) de nguoi
; dang dung ban cu nang cap len van bi dong dung tien trinh.
!macro customInit
  nsExec::Exec 'taskkill /F /IM "G4play Denuvo Manage.exe"'
  nsExec::Exec 'taskkill /F /IM "G4 Denuvo Tool.exe"'
  Sleep 700
!macroend
