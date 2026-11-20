# FGS App Hub

GitHub Pages publishes this repository publicly. Do not add credentials, confidential content, or private data. Google apps and private repositories keep their existing access controls.

Edit `index.html` to add or update a card. The RGB browser app comes from the private rgb-controller repository. When updating `rgb-controller/index.html` from that source, retain the App Hub integration for `?emulator=1`. The original project is not published automatically.

GitHub Pages builds the site when changes are pushed to the configured branch. The RGB app needs a compatible desktop browser and USB serial permission. Physical hardware operation has not been verified by publishing the site.

## RGB Controller Emulator

Open the [RGB Controller Emulator](https://fgs-bfg.github.io/app-hub/rgb-controller/?emulator=1)
to run the controller UI against a virtual serial device and see the strip's PWM output.
Resetting the emulator powers the simulated strip off and keeps presets for the current tab.

To use it from the Windows RGB app, open [COM mode](https://fgs-bfg.github.io/app-hub/rgb-controller/?emulator=1&com=1)
in desktop Chrome or Edge and connect the Pico running the same MCI304 USB bridge as the
locker emulator. Choose the Pico's control interface in the emulator. Keep the tab open
and select the Pico's other COM port in the Windows RGB app at 115200 baud.
Use one emulator per Pico bridge at a time.
The COM view uses a KiCad render of the BIG-41 stage 6 board, with a simulated strip
and a monitor for complete incoming commands.

## Locker troubleshooting guide

Open the [USB troubleshooting guide](https://fgs-bfg.github.io/app-hub/locker-troubleshooting/). Source and maintenance instructions are in `locker-troubleshooting/README.md`; regression tests are in `tests/locker-troubleshooting/`. It connects to a user-selected USB COM port and keeps diagnostic records on that device. Publishing does not verify physical locker operation.

## Locker Connection Check

Share [locker-connection-check.html](https://fgs-bfg.github.io/app-hub/locker-client-check/locker-connection-check.html) as a standalone file. Save it to the computer and open it in desktop Chrome or Edge. The app and recovery photo are embedded. USB access still requires the operator to choose the locker port.

On layouts with master C, recovery sends a single reset to C and then rechecks all fitted boards.

After editing the client app or its shared serial code, run `node locker-client-check/build-standalone.mjs` from the repository root. Commit the generated HTML with the source update.

## MCI 304 Locker Emulator

Open the [locker emulator](https://fgs-bfg.github.io/app-hub/locker-emulator/) in desktop Chrome or Edge. Click **Connect Pico** and select the Tool Kit's browser bridge COM port. Select the corresponding Locker 1–4 COM ports in the desktop locker app. Windows COM numbers can change between PCs.

The Pico OLED menu opens the emulator with a `cabinets` URL parameter from 1 to 4. Every cabinet has 80 bays on boards A-E, with C as master. The Tool Kit exposes one browser bridge COM port and four independent locker COM ports. Each cabinet keeps its own serial monitor and power state. An older two-port Pico bridge still supports the single-cabinet preset. RGB COM mode uses Locker 1's COM port and its own browser tab; disconnect the locker emulator before connecting RGB.

Keep the emulator open while the locker app is connected. It models board C as master, with 1 for an open door and 0 for a closed door. Click an energised door to open it and click it again to close it. The monitor shows the serial commands, replies and door events. The simulator runs in the browser and stores its state for the current connection.

On the Tool Kit OLED, selecting a locker preset shows link status and the selected ports. A filled bar flashes when a locker port sends a command. A thin bar marks ports that have sent traffic during the current connection. Press **Next** to return to the menu, or **Select** to open the cabinet detail screen. In detail view, **Next** moves to the next cabinet and **Select** returns to the activity view. Detail shows the last command, received command count, sent reply-line count, and simulated faults for the selected cabinet. Counts reset when the browser bridge reconnects.

The RGB COM emulator sends power, brightness, and the current RGB colour to the Tool Kit OLED. Press **Next** to return to the menu.

Open a cabinet’s service hatch and click any board to disable it. Click it again to restore it. Multiple boards can be disabled independently. The browser lists all disabled boards, and the Pico OLED shows the first offline board by address. Open **Faults** to manage the boards, hold one door open, or delay replies.

Resetting master C restarts the online boards in its cabinet. A reset sent to another board affects that board alone. The browser simulates the locker behaviour, and the Pico forwards serial traffic.

The cabinet trips when a fifth lock is energised at the same time. Coil drive cuts out immediately, and the controller stops replying over serial. Select **Restore power** on the cabinet to restart the controller. Doors keep their physical positions through the power cycle.
