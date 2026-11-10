# iOS widget corpus

A UIKit app with one tab per family of primitives real apps use: **Controls** (switch, segmented control, slider, stepper, icon-only and filled buttons, a disabled button, compact date picker, email, numeric, secure and multi-line fields, search bar, alert, action sheet, modal), **List** (an inset grouped table with disclosure cells, swipe actions, sections, and 60 rows that run off screen), and **Web** (a `WKWebView` with a link, a field, and a button). Every interaction writes `Last action: <name>`.

Build with `sh build.sh <owned-output-directory>`. Bundle id: `dev.contingency.ioswidgets`. `bin/native-snapshot-capture.mjs ios` builds, installs, and captures it on a simulator it creates and deletes.
