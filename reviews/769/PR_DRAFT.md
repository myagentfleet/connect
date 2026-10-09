# Drive playback from the video element and unify player controls

**Unposted review draft — related to [commaai/connect#769](https://github.com/commaai/connect/issues/769). Full issue acceptance remains open.**

Source: `fd173c1c153e1f893494963675472ad4e448a7ce`, branch `myagentfleet/connect:fix/769-media-playback`. Compared with upstream `109edb39ffa7a4ad3c38788ca2f39a286538ff07`.

## Why this change is needed

Connect estimates route progress from wall-clock time and repeatedly adjusts the player to match that estimate. Loading, failed seeks and missing media can leave the displayed position out of step with the video. The existing controls also divide playback actions across the video, timeline and surrounding layout.

This change makes the media element's clock authoritative for reported progress and brings the video, thumbnail timeline and transport controls into one responsive panel. A native seek that materially misses its requested target now produces a recoverable error when a ready, settled media element reports that target outside its nonempty seekable ranges.

## Playback behavior

Replace ReactPlayer with one route-scoped `<video>` element and a small HLS adapter. Redux retains requested play/pause state, playback speed and seek commands. Media events and a playback-only animation callback report `currentTime`, adjusted for the route's first video frame. The map, timeline playhead, time display and current-segment actions consume that reported position. This removes the separate wall-clock calculation, periodic resynchronization and drift-based playback-rate corrections.

The animation callback reads the media clock; it does not calculate elapsed playback independently. Requested play intent can remain true while buffering or a recoverable error has paused the actual video. `videoStatus` separately describes loading, readiness and failure, so explicit recovery can consistently resume the user's requested state.

The HLS adapter preserves native playback on supported iOS devices and uses pinned hls.js 1.7.3 elsewhere, with native fallback when MSE is unavailable. It starts loading at the latest requested position, destroys its transport on source changes and ignores abandoned imports and callbacks. Failed prefetches do not interrupt usable buffered video. Retry or a subsequent unbuffered seek can explicitly restart loading.

Native HLS can complete a seek at an earlier available boundary without setting a media error. The new guard detects the confirmed failure when a completed native seek has current data, misses a finite current-source target by more than 0.5 seconds, and the browser's nonempty seekable ranges exclude that target with a 0.5-second boundary tolerance. It pauses playback, preserves the selected timeline time and requested play intent, and offers Retry or another timeline selection. The adapter's live native state also covers asynchronous native fallback. A late ended event cannot turn a failed seek into an automatic loop retry or clear the retained intent.

## Player and interaction design

The player, filmstrip, timeline ruler and transport controls share a continuous dark panel. A bright primary Play/Pause action is balanced with elapsed time, ten-second jumps, a speed menu and an audio control. The video itself supports direct Play/Pause interaction. Controls have visible keyboard focus and touch targets; the final style correction keeps the white primary-button background after touch interactions while retaining light-gray desktop hover feedback.

The timeline supports pointer seeking, drag-to-loop selection and keyboard seeking. The map, playhead and elapsed labels follow shared media progress; the thumbnail filmstrip indexes frames for the visible timeline range. On narrow screens, Map/Video switches the visible pane while keeping the same media element mounted. Loading and error overlays belong to the video pane and no longer obstruct Map. Wide layouts place the map beside the player. Files and More info menus retain keyboard access and restore focus to their triggers when dismissed.

## Demo fixtures and regression coverage

Add three synthetic H.264/AAC HLS segments with visible elapsed-time counters, corresponding coordinates, events and thumbnail sprites. The demo exposes complete, missing-first and missing-middle streams. These are repeatable playback fixtures, not real driving footage or a replacement for listening on physical devices. Their documentation describes regeneration and limitations.

Regression coverage exercises source lifecycle and cancellation, pre-metadata and paused seeks, native fallback, failed play requests, buffering, prefetch failure, missing media, explicit Retry and healthy-seek recovery, loop boundaries, route reset, Map visibility, playback controls, thumbnail indexing and demo file listings.

## Validation

| Source | Evidence | Result and scope |
|---|---|---|
| `fd173c1c153e` | [Final Chrome gate](https://github.com/myagentfleet/connect/actions/runs/37938004740) | 169 tests in 17 files, lint, production build and two focused Chrome scenarios. Responsive/interaction checks cover 320, 390, 1280 and 1600 CSS pixels. |
| `fd173c1c153e` | [Final native follow-up](https://github.com/myagentfleet/connect/actions/runs/37938052645) | Two native-HLS recovery paths, strict playback probes, retained timeline selection, correct recovered/resumed pictures, and touch-hover contrast. macOS Playwright WebKit with iPhone emulation; acceptanceRun remains false. |
| `0996a76f1a3d` | [Complete Chrome run](https://github.com/myagentfleet/connect/actions/runs/37936570974) | All seven unfiltered browser scenarios, plus the complete unit/lint/build gate. |
| `0996a76f1a3d` | [Seven-case native investigation](https://github.com/myagentfleet/connect/actions/runs/37936618330) | Declared native checks and frame review passed; the visual review found the touch-background defect subsequently fixed by the final one-line CSS change. Manifest repair uses the inherited 200ms clock/counter threshold, not a strict two-second proof. |

The final two-case follow-ups and the preceding broader runs are attributed to their exact revisions. The earlier two failing native-guard unit assertions were caused by an undefined video.error field in the DOM fixture; 0996a76 explicitly models the observed browser state null without weakening the assertion or changing production behavior.

The separate [stock Safari production-media reference](https://github.com/myagentfleet/connect/actions/runs/37934434822) reproduces the missed seek using unchanged, hash-pinned public qcamera bytes outside Connect. Its eight fresh WebDriver sessions comprise two synthetic and two public-production cases in each of the complete and missing-middle groups, in synthetic/public/public/synthetic order. All four missing-middle target checks failed, including both public-production cases. It demonstrates the browser failure that motivated the guard; it does not execute or validate the new application guard. The public production footage has no audio.

An earlier [stock Safari MSE reference](https://github.com/myagentfleet/connect/actions/runs/37932181369) passed its probes in four original-fixture and four packet-preserved video-only sessions. That run also included four native controls, with one native missing-middle seek failure. These are fresh WebDriver sessions, not fresh Safari processes. Earlier patched-WebKit investigations retained intermittent MSE startup failures; the small stock-Safari matrix does not establish their cause or elimination.

Actual screenshots and their hashes, visual-review findings, source identities and artifact digests are in the accompanying review package. The final desktop and native focused screenshots verify the primary-button correction. The native application evidence uses macOS Playwright WebKit with iPhone emulation, without RVFC observation or diagnostic source transforms. It does not establish branded Safari application acceptance or physical iOS behavior. Recovery measurements occur after error screenshots, and screenshots can affect the native renderer; the recorded clock/counter probes and visible frames are reported separately.

## Requirements still open before claiming full resolution

- Physical iOS and Android browser acceptance, installed-PWA behavior, and background/foreground/OS interactions.
- Audible output, synchronization, Bluetooth and reproduction of the reported physical iOS audio glitch.
- The remaining intermittent patched-WebKit MSE startup concern; the successful small stock-Safari reference matrix does not establish its elimination.
- The literal net-red requirement: the whole contribution changes 48 files with **2,238 additions / 1,279 deletions, net +959 text lines**. Tests are net +989; non-test text is -30; production source excluding demo is -182. These subtotals do not make the complete contribution net red.
- A small, mergeable contribution structure and final line-by-line review before upstream submission. The fixture/demo work is independently useful, but splitting it alone does not satisfy the net-red rule. Relevant player regressions should remain with the player.

The native guard is deliberately bounded. It does not recover unavailable footage, detect a seek that never completes, or diagnose a wrong picture when the clock/ranges look valid. A completion below current-data readiness or with empty seekable ranges remains outside this detection. Existing finite-duration normalization can clamp a requested route target before the guard records it. The tested default-start event sequence advances to the first available segment without a selected-time error; the guard does not exempt every possible initial-seek event order.

## Publication and identity

This is a draft file, not a submitted pull request or a request to close the issue. The feature author and committer are **Agent Fleet <myagentfleet@gmail.com>**, on the **myagentfleet/connect** fork. The QA and review evidence are on separate branches and are not part of the application diff. No upstream PR, issue comment or person-directed message has been sent.

## Review-package recovery

This draft was reconstructed from the completed source review after the local workspace reset. The source and original CI artifacts were retained on GitHub, and all recovered evidence archives were checked against their original digests. This reconstruction is not a new test run.
