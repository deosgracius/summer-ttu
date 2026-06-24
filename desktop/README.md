# Summer on your desktop (auto-start + greeting)

Make Summer greet the central admin by voice the moment Windows starts — the orb
talks, gives the daily update, and you can ask for anything by voice, without opening
the website yourself.

This reuses the dashboard's built-in voice greeting: when the dashboard loads it
automatically says "Hey [name], would you like your daily briefing?" and, on yes, reads
the briefing aloud. `Summer-Desktop.bat` simply opens that dashboard in a clean,
chromeless app window on login, with audio autoplay enabled so it can speak right away.

## One-time setup

1. Sign in once: double-click `Summer-Desktop.bat`. In the window that opens, log in as
   the central admin. The login is remembered by the browser, so you won't have to log
   in again on later launches.

2. Make it start with Windows:
   - Press `Win + R`, type `shell:startup`, press Enter. This opens your Startup folder.
   - Right-drag `Summer-Desktop.bat` into that folder and choose "Create shortcuts here"
     (or copy a shortcut to it there).

That's it. Next time you turn on the computer and sign in to Windows, Summer opens, the
orb greets you, and offers your briefing.

## Notes

- The window is a normal app window (Edge/Chrome "app mode"): the orb and the assistant
  are front and center, no tabs or address bar.
- Voice: say "Hey Summer" or just "Summer" any time to talk; or click the microphone.
- If the greeting doesn't speak on the very first launch, click once anywhere in the
  window — some machines require a single interaction before audio is allowed.
- To stop auto-starting, delete the shortcut from the `shell:startup` folder.

## Want a true floating desktop orb instead?

This app-window approach is the lightweight option. A always-on-top floating orb widget
that sits on your desktop (like a little assistant bubble) would be a small separate
native app (Electron or Tauri). Ask and it can be built as a follow-up.
