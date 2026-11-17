# FGS App Hub

GitHub Pages publishes this repository publicly. Do not add credentials, confidential content, or private data. Google apps and private repositories keep their existing access controls.

Edit `index.html` to add or update a card. The RGB browser app is a copy from the private rgb-controller repository. To update it, review and copy `browser_app/RGB Controller.html` into `rgb-controller/index.html`, then commit and push. The original project is not published automatically.

GitHub Pages builds the site when changes are pushed to the configured branch. The RGB app needs a compatible desktop browser and USB serial permission. Physical hardware operation has not been verified by publishing the site.

## Locker troubleshooting guide

Open the [USB troubleshooting guide](https://fgs-bfg.github.io/app-hub/locker-troubleshooting/). Source and maintenance instructions are in `locker-troubleshooting/README.md`; regression tests are in `tests/locker-troubleshooting/`. It connects to a user-selected USB COM port and keeps diagnostic records on that device. Publishing does not verify physical locker operation.
