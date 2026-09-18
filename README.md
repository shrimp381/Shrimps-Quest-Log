# Shrimps Quest Log

An interactive quest log for Distyr, with GM and player views, tabs and categories, dated updates, party notes, an optional Segmented Cycle tie in, and its own internal calendar.

## What it does

- **Add and edit quests.** Each quest has a title, category, summary, and status (Active, Completed, Failed). Click a quest's summary row to expand it.
- **Tabs.** Quests are split across Main Quest, Side Quest, and Rumours by default. As GM you can rename any tab, delete one (as long as one remains), and add new ones with the "+ Tab" button. Completed and Failed quests are automatically pulled out of their tab and shown, with their title struck through in their status colour, on a fourth "Finished" tab that always exists and can't be deleted.
- **Categories.** Each tab has its own set of categories (city, faction, region, whatever fits), editable and deletable by the GM, used to filter that tab's quest list.
- **Quest Updates.** GM-authored notes that get added to a quest as more of it is revealed. Each one can be toggled between hidden and revealed; once revealed, players see it and it is stamped with the date it was revealed, not the date the GM wrote it. The GM can delete any update or party note.
- **Party Notes.** Anyone can add a note to a quest, and it is signed with their name and the in-game date. The GM can delete any note.
- **Segment Cycle Integration.** Optional, per quest, GM side, and only shown if the Segmented Cycle module is installed and active. Pick which bar (Day, Night, or the custom bar) a quest is tied to and how many segments it needs; as that bar fills up in Segmented Cycle, the quest's own counter ticks forward automatically. A "Force tick" button is there for a manual override.
- **Calendar Link.** Optional, per quest, GM side. Pin a quest to a date on Shrimps Quest Log's own calendar with "Set Date", so the party can see it coming from the calendar panel at a glance. "Change" and "Clear" undo or move it.
- **Internal calendar.** Fully self-contained: name your months, set how many days each one has, and set a year label. The in-game date at the top of the log, the persistent calendar panel, and every date stamped on a quest, update, or note all come from this. If Simple Calendar is installed and active, Shrimps Quest Log can instead show its date at the top of the log (toggle this in the settings cog); the calendar panel below always keeps browsing Shrimps Quest Log's own calendar regardless, since that is what carries the quest deadlines and notes.
- **Calendar panel.** A collapsible panel, top right of the log, showing the current month as a grid. Today is highlighted, and any date with a note or a quest linked to it gets a small dot. Click a date to see what's on it; as GM you can add or delete freeform notes there (upcoming events, deadlines).
- **Settings cog.** Top of the log, GM only. Toggle the calendar section and the Segment Cycle section on or off for the whole table, and build out the internal calendar's months from here.
- **Scene Controls button.** A "Shrimps Quest Log" tool (scroll icon) sits in the canvas Scene Controls toolbar, in the same Notes group Simple Calendar and similar modules use. Click it to open or close the log.

## What is shared vs personal

Every quest, tab, category, update, note, calendar setting, and calendar event lives in one world setting, shared with the whole table. Only a GM can write to it directly; when a player adds a party note, their client asks a connected GM's client to make the change on their behalf, which then syncs back out to everyone as normal. This means **a GM needs to be online for a player's note to be added** — it is not queued if no GM is connected.

Everything else (which tab you're looking at, which quest is expanded, draft text you're mid-typing) is local to your own window and isn't shared or saved.

## Installing

This module has not been submitted anywhere, so install it as a local/manual module:

1. Locate your Foundry `Data/modules` folder.
   - Self-hosted: inside wherever you pointed Foundry's user data directory.
   - Forge: use the Bazaar's file manager (or the "My Assets" file browser) to upload into `Data/modules/`.
2. Copy the whole `shrimps-quest-log` folder (this one, containing `module.json`) into `Data/modules/`, so the path reads `Data/modules/shrimps-quest-log/module.json`.
3. In your world, go to Game Settings > Manage Modules, enable "Shrimps Quest Log", and save.
4. Reload. Everyone should see a "Shrimps Quest Log" tool (a scroll icon) in the Notes group of the Scene Controls toolbar on the left edge of the canvas. Click it to open the log.
5. As GM, click the settings cog at the top of the log to set up your calendar's months before you start logging quests, since new quests are stamped with whatever the current date is at the moment you set up.

## Optional: Simple Calendar

Shrimps Quest Log works fully without it. If Simple Calendar is installed and active, open the settings cog and turn on "Sync the displayed date with Simple Calendar" to have the top of the log show Simple Calendar's current date instead of Shrimps Quest Log's own, for logging and stamping purposes. The calendar panel (the grid, its notes, and quest deadline links) always stays on Shrimps Quest Log's own internal calendar either way, since Simple Calendar doesn't expose enough about its own month/day layout to safely rebuild a matching grid from here.

## Optional: Segmented Cycle

Shrimps Quest Log works fully without it, and the Segment Cycle Integration section on a quest is hidden entirely unless the Segmented Cycle module is installed and active. When it is, tie a quest to Day, Night, or the custom bar; every segment that bar fills in Segmented Cycle ticks that quest's counter forward by the same amount, up to whatever you allocated.

## Known limitations (still untested live)

This was built and syntax checked outside of Foundry; there is still no Foundry instance available to test it live from here, same as with Segmented Cycle originally. Likely rough edges:

- **The toolbar button** uses the same `getSceneControlButtons` approach as Segmented Cycle, covering both the v11/v12 and v13+ shapes of that hook. If no "Shrimps Quest Log" tool shows up in the Notes group, tell me and it gets fixed for your version.
- **Simple Calendar's API** varies between its own versions; `currentDateTimeDisplay()` is used defensively (wrapped so a failure just falls back to Shrimps Quest Log's own calendar) but hasn't been checked against a real install.
- **Segmented Cycle's tick detection** works by watching its `dayFilled`/`nightFilled`/`customFilled` world settings for changes and diffing against the last known value, since Segmented Cycle doesn't expose a dedicated API for this. It should track normal pip clicks and resets correctly, but hasn't been checked against a real install either.
- **Player notes need a GM online**, as explained above; there's no offline queueing yet.
- The window uses Foundry's classic `Application` class (like Segmented Cycle's settings form) for broad version compatibility; on the newest Foundry versions this may log a deprecation warning in the console, it should still work.

Report back what breaks and it gets fixed from there.
