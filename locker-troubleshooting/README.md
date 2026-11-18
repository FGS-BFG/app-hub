# MCI 304 USB troubleshooting guide

The maintained source and authenticated Google Drive backend are in the private [Mci-Test-App repository](https://github.com/FGS-BFG/Mci-Test-App). This directory is the public browser copy.

Use **Save to Drive** to freeze a report and save it through the authenticated Google portal. **Saved reports** opens the central library. **New report** starts a blank report after the current report is confirmed in Drive. Failed saves keep the same frozen report for retry. **Download copy** is separate from central saving.

Every opening or refresh starts a new test at the welcome screen, with blank details and a new report ID. The operator must select 80, 64 or 32 bays before continuing. Capacity controls the fitted columns used for communication, monitoring, sensor snapshots, door tests and reports: 80 bays use A–E; 64 bays use A, B, C and D; 32 bays use A and B with B as master. The 64- and 80-bay layouts use master C. Capacity is recorded in drafts, saved/downloaded reports and frozen retries, with no preselected value on a new test. Capacity cannot change after the starting observation or USB or door-test evidence has been recorded; start a new report for a different layout. Old results and locker steps are never resumed automatically. Returning from Google sign-in keeps the test currently being saved.

After location and name, an identification step shows both master/slave photo sets: flat Input Sense ribbons and individual sensor wires. Mixed and Not sure choices are available. Optional installed-board labels and configuration notes are included in the saved report. Copy the actual labels; reference photos do not identify installed firmware. The photo panel can display either setup without changing the recorded choice. This selection does not change the A–E / master C test protocol.

Use **Unfinished tests** to recover a read-only report retained on this device, then save it to Drive or download it. Frozen retries keep their original ID, time and text. Drafts from separate browser tabs use separate storage keys. Saved reports remain in central Drive storage.

Reports belong in **1-Current productions → Field reports**. The portal uses the accessing user's Google permissions. The existing endpoint was updated to version 2 on 18 November 2026 at 08:17 Europe/London. Google authorization, a real save from the public guide in Chrome, and a library read succeeded with an FGS Workspace account. The guide displayed the saved report as read-only. No USB hardware was connected. Live retry behavior and permissions for other users remain unverified.

Open the [live guide](https://fgs-bfg.github.io/app-hub/locker-troubleshooting/) in desktop Chrome or Edge on the computer connected to the locker. Record parkIT's current status when prompted. Close parkIT before the later USB connection step, then select the configured master's COM port.

The guide walks through the mains cycle, master reset, installed-board ISB checks, physical self-test and connection comparisons. It can monitor raw sensor inputs on the fitted boards and save a report with timestamps and USB traffic to Drive. Browser storage retains drafts and pending retries; a central save is confirmed by the Drive receipt.

## Guided procedure

Each screen gives the operator one action and a Next button. After capacity and board identification, **Can parkIT communicate with the locker?** asks whether all columns, some, none or an unknown number currently respond. Some requires the nonresponding columns to be selected from the fitted layout. Optional notes retain messages and intermittent symptoms. The page sends no USB commands. Next timestamps and locks this starting observation and the capacity; Back cannot rewrite it. Drafts and reports retain it separately from later measured ISB results. Older reports remain valid, and frozen retries keep their original text.

Next, cycle the locker mains supply and wait for startup. The following screen asks the operator to connect the black USB cable, close parkIT and select the locker COM port.

Opening the port does not confirm communication. The guide requires a valid input-status reply from the configured master. If the connection is not confirmed within 60 seconds, it asks the operator to check the power and cable, close the parkIT app, then retry or use the physical self-test.

When the expected master does not reply, one read-only A–E address check can identify other responding boards. Discovery includes addresses outside the selected capacity and does not reset a board or open a door. If A replies while C is expected, the operator can choose **Continue with board A only**. The page identifies A from a valid addressed reply; it does not assign A the locker-master role. Disconnecting invalidates an unconfirmed choice, and a different port requires a new check.

After confirmation, subsequent inputs, monitoring and selected-door operations target only that board. Master reset, slave cable comparisons and discovery of other boards are blocked. One fresh input reading precedes the explicit door test. The report keeps the original layout/master as context, records discovery and the operator choice, and describes only the selected board's results. Reconnect retains that scope and requires fresh target readings before an explicit opening. A new report clears it. Scope cannot change after full locker checks or a reset have started.

After the first valid reply, the guide watches the configured master for 60 seconds. A fresh final reply is required before Next becomes available. Failed replies or a disconnected USB port remove the ready status. Selecting Next sends the master reset automatically. After the reset wait, the next screen checks the fitted boards automatically.

For a connection swap or replacement cable, the guide waits for the operator to confirm the physical change before it sends the corresponding checks. Detailed controls and the USB log are under Advanced diagnostics. Monitoring controls become available at the result. The optional location field starts blank.

## Protocol and limits

The transport uses 9600 baud, 8N1, no flow control, DTR/RTS low, and ASCII commands terminated by CR with 10 ms character spacing. Diagnostic commands are `ISB#A` through `ISB#E` and reset of the configured master. Reset waits six seconds; an acknowledgement does not establish a CPU reset or slave reset. The separate explicit door test uses the scoped opening and lock-off commands described below. Single-board testing blocks reset commands.

Valid ISB replies must contain exactly 16 binary inputs and match the requested board. Silent timeouts record no response. USB failures, malformed replies and wrong addresses leave checks incomplete. Input 1 is the rightmost bit; open/closed polarity is not assumed. Multiple changes are observations, not component diagnoses.

This protocol has no transaction IDs. Draining late data reduces stale-reply risk but cannot prove that a very late reply belongs to a later request to the same board. Protocol handling follows the existing tester and supplied legacy firmware; the installed firmware has not been verified.

## Development

From the App Hub repository root:

```text
python -m http.server 8765 --bind 127.0.0.1
node --test tests/locker-troubleshooting/*.test.mjs
node --check locker-troubleshooting/app.js
```

Open `http://127.0.0.1:8765/locker-troubleshooting/` for a local preview. `app.js` connects the prompts to `usb-ui.js`; `flow.js` owns decisions and reports; `serial.js` handles Web Serial and framing. Photos and the original manual Word procedure are bundled in `assets/`.

The tests cover decision paths, reports, input mapping and mock serial streams. Browser USB checks used simulated replies, timeouts, malformed data, sensor changes and disconnection. A real authenticated Drive save and library read are verified with an FGS Workspace account. Physical locker operation, live retries and access with other Google accounts still need validation.

This directory owns the GitHub Pages copy. The earlier private Sites version is separate and does not update automatically.

## Guided door checks

During a release, the diagram shows red for sensor-open inputs and green for the selected active release command. Red takes precedence when the door opens. Green clears after lock-off; uncertain lock-off uses amber. Grey is not a physical lock confirmation. Reports retain the release limit, selected input rule and relock reason in the step record.

After recording the connection setup, click a door in the diagram to start its release test. The app first reads the sensors and identifies any open doors on the selected column. Close the named doors before trying again.

The physical self-test screen includes **Need help finding the red button?**, with close-ups for both flat Input Sense ribbons and individual sensor wires. It defaults to the recorded setup and lets the operator switch the reference or enlarge the full-board photo. These help controls do not start the timer, send commands, change the recorded setup or choose an answer. The instructions identify the configured master, including B for 32 bays.

Test at least one door on each fitted column. Answer whether the selected door opened. Close it, then answer whether it closed. The app reads the inputs when you record the closing answer. The report retains each result if you test more doors on a column.

Slave cable comparisons exclude the configured master. The 80-bay layout permits A with B and D with E; the 64-bay layout permits A with B; the 32-bay layout has no adjacent slave pair. A failed column without an adjacent working slave is recorded as unresolved and is not compared by swapping the master connection. Older targetless reports retain their historical A–E meaning, and frozen retries keep their original text. Actual older readings outside the current layout remain identified as historical evidence. The downloadable Word procedure describes the original 80-bay layout.

The door release uses an addressed manual LM0–LMF command after scoped LMX preclear. The app polls only the selected board while released and sends LMX when the matching input reads 1 (open), at the 15-second deadline, or if the read fails. The matching input must read 0 (closed) before release. This input map and polarity were confirmed by the operator. No global timer setting is changed. The browser owns this timer; manual release has no independent firmware timeout. USB loss or browser termination can prevent lock-off. Keep the page visible and USB connected until lock-off is sent. Successful writes establish transmission only; physical observations are still recorded separately.

Command transmission, raw sensor changes and physical observations remain separate evidence. The release monitor uses the confirmed matching input with 1=open and 0=closed. Other raw readings remain separate from physical observations. Short changes between reads can be missed. `Tested` records an attempted command and operator answers; it is not an automatic functional pass. Each column requires a recorded result or a reason why the check could not be completed. Reports retain per-bank snapshots, up to 200 polling samples, transmission times, operator answers and skip reasons.

The door release uses an addressed manual LM0–LMF command after scoped LMX preclear. The app polls only the selected board while released and sends LMX when the matching input reads 1 (open), at the 15-second deadline, or if the read fails. The matching input must read 0 (closed) before release. This input map and polarity were confirmed by the operator. No global timer setting is changed. The browser owns this timer; manual release has no independent firmware timeout. USB loss or browser termination can prevent lock-off. Keep the page visible and USB connected until lock-off is sent. Successful writes establish transmission only; physical observations are still recorded separately.

The configured master is captured when opening USB and starting the connection check. A layout change requires a new connection; a C reply cannot verify master B. Resets are restricted to the configured master (RST#B for32, RST#C for64/80). New door records store their master. Older reports retain their recorded controller context and frozen text, including prior B/C layouts. The reference photographs show a C-master example; the 32-bay screen and enlarged-photo caption identify the installed master as B and slave as A.
