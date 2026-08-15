# Join Spanish programming subreddits

## Context
- App package / Activity where this starts: `com.reddit.frontpage` (home feed, logged in as u/Significant_Let_6361)
- Precondition: Reddit installed and logged in; search bar accessible from home.

## Steps
inside u2bun (workdir: `u2bun/`)

1. `adb -s <SERIAL> shell monkey -p com.reddit.frontpage -c android.intent.category.LAUNCHER 1` → launch Reddit.
2. `ui snapshot` → confirm logged in ("Cuenta de Significant_Let_6361" at bottom).
3. `ui tap --text "Encuentra lo que quieras"` → focus search bar.
4. `ui input --text "programación"` → `ui press --key enter` → results list.
5. `ui snapshot --limit 60` → communities under "Comunidades" heading.
6. For each target community (biggest first: r/devsarg, r/programacion, r/taquerosprogramadores, r/programacionESP):
   - `ui tap --text "r/<name>"` → community page opens.
   - `ui snapshot` → find `Button "Unirse a r/<name>"` handle (NOTE: text has invisible BOM char `\uFEFF` after "r/"; tap by `--ref @N`, NEVER by --text).
   - `ui tap --ref @N` → verify snapshot now shows `Button "Salir de r/<name>"`.
   - `ui tap --ref @N` on "Volver" → back to results.
7. Optional: if a "Recursos"/welcome bottom sheet appears after joining, tap `Button "Cerrar hoja"` then re-snapshot to verify.

## Postcondition
- Reddit home feed visible; subscriptions include the chosen Spanish programming communities.

## Known Pitfalls
- Subreddit names in the app contain an invisible BOM (`r/﻿devsarg`); selectors using `--text "Unirse a r/devsarg"` FAIL. Always snapshot first and tap by `--ref @N`.
- `ui scroll` can throw `TRANSIENT` SecurityException; fall back to `ui swipe --from-pos 540,1600 --to-pos 540,600`.
- Skipped tiny subreddits in results: r/programadores (~7 weekly), r/programar (~2), r/programacion_Arg (~2) — not worth joining.
- Device serial: `192.168.1.19:5555` (WiFi).
