# MCI 304 USB troubleshooting guide

The maintained source and authenticated Google Drive backend are in the private [Mci-Test-App repository](https://github.com/FGS-BFG/Mci-Test-App). This directory is the public browser copy.

Use **Save to Drive** to freeze a report and save it through the authenticated Google portal. **Saved reports** opens the central library. **New report** starts a blank report after the current report is confirmed in Drive. Failed saves keep the same frozen report for retry. **Download copy** is separate from central saving.

Every opening or refresh starts a new test at the welcome screen, with blank details and a new report ID. The operator must select 80, 64 or 32 bays before continuing. Capacity controls the fitted columns used for communication, monitoring, sensor snapshots, door tests and reports: 80 bays use A–E; 64 bays use A, B, C and D; 32 bays use B and C. C is the master in every confirmed layout. Capacity is recorded in drafts, saved/downloaded reports and frozen retries, with no preselected value on a new test. Capacity cannot change after USB or door-test evidence has been recorded; start a new report for a different layout. Old results and locker steps are never resumed automatically. Returning from Google sign-in keeps the test currently being saved.

After location and name, an identification step shows both master/slave photo sets: flat Input Sense ribbons and individual sensor wires. Mixed and Not sure choices are available. Optional installed-board labels and configuration notes are included in the saved report. Copy the actual labels; reference photos do not identify installed firmware. The photo panel can display either setup without changing the recorded choice. This selection does not change the A–E / master C test protocol.

Use **Unfinished tests** to recover a read-only report retained on this device, then save it to Drive or download it. Frozen retries keep their original ID, time and text. Drafts from separate browser tabs use separate storage keys. Saved reports remain in central Drive storage.

Reports belong in **1-Current productions → Field reports**. The portal uses the accessing user's Google permissions. The existing endpoint was updated to version 2 on 18 November 2026 at 08:17 Europe/London. Google authorization, a real save from the public guide in Chrome, and a library read succeeded with an FGS Workspace account. The guide displayed the saved report as read-only. No USB hardware was connected. Live retry behavior and permissions for other users remain unverified.

Open the [live guide](https://fgs-bfg.github.io/app-hub/locker-troubleshooting/) in desktop Chrome or Edge on the computer connected to the locker. Close the other locker applications, then select master C's COM port when prompted.

The guide walks through the mains cycle, master reset, five-board ISB checks, physical self-test and connection comparisons. It can monitor raw sensor inputs on one board or all five, and save a report with timestamps and raw USB traffic to Drive. Browser storage retains drafts and pending retries; a central save is confirmed by the Drive receipt.

## Guided procedure

Each screen gives the operator one action and a Next button. First, cycle the locker mains supply and wait for startup. The next screen asks the operator to connect the black USB cable and select the locker COM port.

Opening the port does not confirm communication. The guide requires a valid input-status reply from master C. If the connection is not confirmed within 60 seconds, it asks the operator to check the power, cable and other locker applications, then retry or use the physical self-test.

After the first valid reply, the guide watches master C for 60 seconds. A fresh final reply is required before Next becomes available. Failed replies or a disconnected USB port remove the ready status. Selecting Next sends the master reset automatically. After the reset wait, the next screen runs the five-board checks automatically.

For a connection swap or replacement cable, the guide waits for the operator to confirm the physical change before it sends the corresponding checks. Detailed controls and the USB log are under Advanced diagnostics. Monitoring controls become available at the result. The optional location field starts blank.

## Protocol and limits

The transport uses 9600 baud, 8N1, no flow control, DTR/RTS low, and ASCII commands terminated by CR with 10 ms character spacing. It accepts only `ISB#A` through `ISB#E` and `RST#C`. Reset waits six seconds; an acknowledgement does not establish a CPU reset or slave reset. No lock activation commands are sent.

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

Before the final report, the operator tests one selected door on each fitted column. Record whether the original connections are restored or describe the changed connections fitted. Choose a door, confirm it is closed and clear, then select **Open door**. Opening requires that explicit click. Entering the step, Back, reconnecting, refresh and report recovery never activate outputs. Absent columns are not queried or activated; direct USB reads, mixed scans and door commands to inactive addresses are rejected before I/O.

Slave cable comparisons exclude master C. The 80-bay layout permits A with B and D with E; the 64-bay layout permits A with B; the 32-bay layout has no adjacent slave pair. A failed column without an adjacent working slave is recorded as unresolved and is not compared by swapping the master connection. Older targetless reports retain their historical A–E meaning, and frozen retries keep their original text. Actual older readings outside the current layout remain identified as historical evidence. The downloadable Word procedure describes the original 80-bay layout.

The app requires fresh addressed starting readings from the selected column and master C. It uses the legacy 304 firmware-timed `LA0`–`LAF` command, with `LMX` to clear outputs on the selected bank before and after the intended 500 ms pulse. It requests one sensor reading during the pulse, watches the selected column for another 10 seconds, then reads the other columns. The operator records whether the door physically opened, closes it, reads the inputs again, and records whether it is now closed. Door numbers 1–16 use hardware outputs 0–F, matching the existing tester.

Command transmission, raw sensor changes and physical observations remain separate evidence. No sensor polarity or door-to-input mapping is assumed. Short changes between reads can be missed. `Tested` records an attempted command and operator answers; it is not an automatic functional pass. Each column requires a recorded result or a reason why the check could not be completed. Reports retain per-bank snapshots, up to 200 polling samples, transmission times, operator answers and skip reasons.

Other commands, navigation, saving and new reports are blocked during the door operation. Stop or hiding the page requests cancellation and scoped lock-off. Opening is never retried automatically. Failed lock-off blocks further activation on that connection. Quiet-mode commands have no required acknowledgement; completed USB writes establish transmission only. The 500 ms dwell depends on browser software. The firmware fallback uses the controller's existing timer configuration, whose installed behavior is unverified. USB loss or browser termination can prevent software lock-off. Physical operation and installed firmware timing still require a locker trial.
