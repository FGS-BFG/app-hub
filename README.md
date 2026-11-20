# FGS App Hub

GitHub Pages publishes this repository publicly. Do not add credentials, confidential content, or private data. Google apps and private repositories keep their existing access controls.

Edit `index.html` to add or update a card. The RGB browser app comes from the private rgb-controller repository. When updating `rgb-controller/index.html` from that source, retain the App Hub integration for `?emulator=1`. The original project is not published automatically.

GitHub Pages builds the site when changes are pushed to the configured branch. The RGB app needs a compatible desktop browser and USB serial permission. Physical hardware operation has not been verified by publishing the site.

## RGB Controller Emulator

Open the [RGB Controller Emulator](https://fgs-bfg.github.io/app-hub/rgb-controller/?emulator=1)
to run the controller UI against a virtual serial device and see the strip's PWM output.
Resetting the emulator powers the simulated strip off and keeps presets for the current tab.

## Locker troubleshooting guide

Open the [USB troubleshooting guide](https://fgs-bfg.github.io/app-hub/locker-troubleshooting/). Source and maintenance instructions are in `locker-troubleshooting/README.md`; regression tests are in `tests/locker-troubleshooting/`. It connects to a user-selected USB COM port and keeps diagnostic records on that device. Publishing does not verify physical locker operation.

## Locker Connection Check

Share [locker-connection-check.html](https://fgs-bfg.github.io/app-hub/locker-client-check/locker-connection-check.html) as a standalone file. Save it to the computer and open it in desktop Chrome or Edge. The app and recovery photo are embedded. USB access still requires the operator to choose the locker port.

After editing the client app or its shared serial code, run `node locker-client-check/build-standalone.mjs` from the repository root. Commit the generated HTML with the source update.

## MCI 304 Locker Emulator

Open the [locker emulator](https://fgs-bfg.github.io/app-hub/locker-emulator/) in desktop Chrome or Edge. Plug in a Pico running the MCI304 USB bridge and click **Connect Pico**. Choose its cabinet COM interface. Select the other Pico COM interface in the locker operation app. On a new PC, the assigned COM numbers can change. The cabinet checks the bridge protocol before accepting a port.

Keep the emulator open while the locker app is connected. It models board C as master, with 1 for an open door and 0 for a closed door. Click an energised door to open it and click it again to close it. The monitor shows the serial commands, replies and door events. The simulator runs in the browser and stores its state for the current connection.

The cabinet trips when a fifth lock is energised at the same time. Coil drive cuts out immediately, and the controller stops replying over serial. Select **Restore power** on the cabinet to restart the controller. Doors keep their physical positions through the power cycle.
