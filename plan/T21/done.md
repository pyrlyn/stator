# T21. Closing report

Fixed (plan-notes 370). T17 was merged with red CI (`pipeline` failed in 0 s, `frontend (windows/arm64)` failed), so required checks were missing or bypassable. `protect-main` now requires `pipeline / gate`, `static analysis`, `frontend (linux/x64)` and both Windows frontend legs; the desktop matrix name bug that made those legs unmatchable is fixed.
