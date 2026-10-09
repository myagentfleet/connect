# connect #769 — implementation and review guide

## Review conclusion

The candidate implements a substantial playback redesign and has been reviewed against [commaai/connect issue #769, “make video playback beautiful”](https://github.com/commaai/connect/issues/769). It is ready for a concrete engineering and design review. **It does not yet satisfy the issue in full.** The complete diff is **+959 text lines**, so the literal net-red requirement remains unmet. Physical iOS and Android browsers, installed mobile PWAs, and the reported iOS audio behavior still need direct evidence.

The reviewed source is [`fd173c1c153e1f893494963675472ad4e448a7ce`](https://github.com/myagentfleet/connect/commit/fd173c1c153e1f893494963675472ad4e448a7ce) in `myagentfleet/connect`, compared with upstream `109edb39ffa7a4ad3c38788ca2f39a286538ff07`. The final commit changes one playback-button style; the preceding behavioral revision is `0996a76f1a3d963cde7f0d10b211c5cd02fb0c0e`.

Both author and committer on the final source commit are **Agent Fleet <myagentfleet@gmail.com>**. The source was published using the verified user fork/account. No upstream pull request has been authorized or opened as part of this work; [PR_DRAFT.md](PR_DRAFT.md) is a review draft.

## How to use this package

Start with [index.html](index.html) for the restored screenshot viewer. Compare the upstream player with the candidate at narrow and wide sizes, then inspect interaction and error states. Screenshots show measured states; they are not an interactive deployment or evidence of all device behavior.

Use [status.json](status.json) for the restored artifact inventory and provenance, [requirements-review.json](requirements-review.json) for the detailed requirement record, and [evidence.zip](evidence.zip) for the retained evidence. [SHA256SUMS](SHA256SUMS) records the package checksums. Commit-pinned source and Actions links below remain the reference points if a local artifact is unavailable.

A useful review order is:

1. Compare the four layout sizes and inspect the primary playback control, timeline, and desktop map relationship.
2. Inspect Files, More info, keyboard focus, loading, unavailable video, Map mode, and return to Video.
3. Read the playback ownership and native-seek design below, then inspect the corresponding source and regression tests.
4. Review CI reports by their exact source revision and scenario list.
5. Review the open requirements before deciding on contribution scope or submission.

This guide was reconstructed on 2026-10-09 from the completed review after a workspace reset. Reconstructing the guide did not rebuild the application, rerun tests, or create new browser observations. Artifact restoration and its verification are recorded separately in the package inventory.

## What was verified, and on which revision

| Evidence | Source | Verified scope | Interpretation |
| --- | --- | --- | --- |
| [Final desktop run 37938004740](https://github.com/myagentfleet/connect/actions/runs/37938004740) | `fd173c1…` | 169 tests in 17 files; lint with zero warnings/errors; production build; two Chrome scenarios: healthy comparison and controls/responsiveness | All listed checks passed. This run did not repeat the other five Chrome scenarios. |
| [Final native/touch run 37938052645](https://github.com/myagentfleet/connect/actions/runs/37938052645) | `fd173c1…` | Two native HLS recovery paths: explicit Retry and a new healthy seek; touch hover styling measured before and after capture | Both passed in macOS Playwright WebKit with iPhone emulation. The report is marked `acceptanceRun: false`. |
| Preceding full Chrome report | `0996a76…` | Seven scenarios: healthy comparison; controls/responsiveness; missing first segment and Retry; natural middle-gap recovery; MSE prefetch and loops; startup seek and route reset; navigation cancellation and loading | All seven passed. The final change after this source is the single CSS fallback. |
| [Preceding native run 37936618330](https://github.com/myagentfleet/connect/actions/runs/37936618330) | `0996a76…` | Seven native cases: three diagnostic observations and four passing recovery/startup cases | The seven-case scope is not seven independent platform acceptance tests. The report is marked `acceptanceRun: false`. |
| [Upstream comparison run 37891933708](https://github.com/myagentfleet/connect/actions/runs/37891933708) | Upstream baseline | Retained upstream comparison artifact, restored for visual review | Use the artifact inventory for its exact source and retained files. |

The final desktop run is job `113844845260`, QA commit `31df5d0d906dece4d6c967ff2505b835cd795396`, artifact `11620335347`. Its GitHub-supplied archive SHA-256 was independently matched during the completed review:

```text
f6a3844bb5fef3b8e17f4c8cd56e382dfc00d12929a96d8c3c8abdba76199a5f
```

The native scenarios use a real native HLS URL without Hls.js or requestVideoFrameCallback. New recovery/startup checks measure at least two seconds of clock advance and decoded/non-dropped frames, including a later sample window. Paused target checks precede their screenshots. The inherited manifest-retry scenario has a shorter 200 ms / 0.15 s playback check and must not be described as the same strict probe.

Burned timestamps in readable frames were compared with sampled clocks. These observations support the specific target and recovery assertions; clock and counter progress alone do not establish continuously smooth playback on every platform. Recovery measurements also follow error screenshots, so they are not evidence of screenshot-free recovery.

## Design decisions and visual review

The player retains connect's dark palette and existing Material UI conventions. The redesign gives the main action a clear hierarchy: a 44 × 44 white circular Play/Pause button, with jump controls and compact secondary speed/audio actions. Narrow layouts place elapsed and recorded time above the transport row, while the wider layout keeps video and map together. Rounded video, timeline, and footer surfaces form a compact panel.

The thumbnail timeline retains real time context, previews, and loop selection. Accessible labels, keyboard controls, a visible 2 px focus outline, focus restoration after menus, and reduced-motion styling support interaction beyond pointer use. These are implemented behaviors with measured examples; they are not a complete assistive-technology certification.

The final CSS fix handles a concrete touch defect. Material UI's touch hover rule made the white Play/Pause circle transparent after a tap. A local hover fallback now preserves white on hover-incapable devices, while the existing desktop hover rule still produces light gray. The final native check required the button to remain hovered, not active, under `(hover: none)`; moving the pointer away was not used to hide the defect.

The completed independent desktop inspection covered seven current images: four stable comparison sizes, the primary hover control, Files, and More info. All 22 unique PNGs in that desktop artifact decoded successfully. The report listed 23 screenshot entries because the speed-menu filename appeared twice; none were missing.

The four stable comparison images at nominal widths 320, 390, 1280, and 1600 were **pixel identical to the preceding source's images**. This comparison establishes that the final style fix did not alter those measured layouts. It is separate from the broader redesign comparison against upstream.

The final desktop primary hover state was `rgb(229, 233, 236)` with a dark icon, both before and after capture. More info was inspected after its real opening transition completed: opacity 1, identity transform, no active animations, and bounds x=16, y=181, width=296.390625, height=113. Its menu region matched the preceding capture exactly. Files retained its visible geometry and readable contents; its popup comparison differed by at most one RGB value per channel. Neither menu showed clipping or overlap in the reviewed state.

The runtime checks confirmed that keyboard focus returned to Files and More info after dismissal. The keyboard jump control was visible with a solid 2 px outline. The final native touch images have a separate visual review; the desktop reviewer does not claim an independent inspection of those images.

## Playback and recovery architecture

**The video element owns progress.** Its current time drives the shared position used by the timeline and map. An explicit seek command is distinct from progress publication, so updating progress does not trigger another seek. Requested playback intent can survive buffering or an error for explicit recovery; it is not a second clock. Native events synchronize ordinary play/pause behavior, and stale source callbacks, pending play promises, and navigation are guarded.

**Transport is a small adapter around the same media element.** Native HLS remains available for the iOS path, with Hls.js/MSE elsewhere when supported and a native fallback when needed. Future prefetch failure does not interrupt already buffered healthy playback or a valid buffered loop. A later explicit seek into unavailable data can restart the loader. This is not a claim that every browser decoder or audio problem has been resolved.

**Loading and failure are explicit states.** The player presents a visible loading indicator or an actionable error with Retry. Tests exercise missing first and middle segments, manifest errors, source refreshes, seeks before metadata, loops, cancellation, and recovery. Fixtures return genuine HTTP failures and repaired bytes.

A bounded native-seek guard addresses an observed failure where a requested target settled at a different available time without a native error. It retains the latest normalized target for the active source, then checks a settled native seek only when the element is no longer seeking and has current data. A difference greater than 0.5 seconds, together with a nonempty seekable range that excludes the target with a 0.5-second margin, produces a specific unavailable-time error before the wrong clock is published. The element pauses; requested position and playback intent remain available for explicit Retry or a new seek.

This detector uses no polling or automatic reload. Recovery continues through the existing explicit Retry/new-seek path. Empty seekable ranges and low-readiness events retain their prior behavior; this is a conservative detector, not a general outage detector. Completed/default targets are cleared, normal startup at the first available frame remains possible, and late ended events cannot restart a failed loop automatically.

**Map remains usable while video loads or fails.** Map mode hides the video status/action overlay using the existing visibility state. The same media element stays mounted, and hidden Retry is absent from the DOM and keyboard order. Returning to Video restores the appropriate status. Desktop video-plus-map behavior is preserved.

## Requirement status

| Requirement | Status | Reason or remaining work |
| --- | --- | --- |
| Let native video drive playback state | Implemented | The media clock owns shared progress; explicit seeks and requested playback intent have distinct roles. |
| Reliable loading, fast seeking, and error handling | Verified in enumerated scenarios | Real missing data, recovery, looping, startup, and cancellation are covered. Unavailable video receives an actionable response. |
| Preserve map and thumbnail timeline | Implemented and exercised | Both remain integrated; Map is usable during loading/error. Live map tiles were not independently certified. |
| Tasteful, modern, responsive interaction | Reviewed in measured states | Four sizes, menus, focus, touch/desktop hover, timeline, and status states were inspected or asserted. |
| Desktop browser coverage | Partial | Chrome evidence is extensive; earlier Firefox/WebKit/Safari evidence is bounded. An intermittent WebKit/MSE startup freeze at 0.164 s has not been demonstrated eliminated. |
| Physical iOS and Android browsers | Pending | Emulated iPhone WebKit/native HLS evidence is not a physical iOS or Android run. |
| Installed iOS and Android PWAs | Pending | Installation, lifecycle, background/foreground, and OS media behavior need device evidence. |
| Reported iOS audio glitch | Pending end-to-end verification | Audio-track/mute/rate/native-path coverage does not prove physical audible output, synchronization, or the reported glitch resolved. |
| A net-red complete diff | Unmet | 2,238 additions minus 1,279 deletions equals +959 text lines. |
| Demo-based testing without a device | Implemented | Deterministic routes and real HLS fixtures support reproducible checks. |
| Small, clean contributions with tests | Substantial progress; submission scope pending | Production code is smaller, regression tests are retained, and QA is separate. A final mergeable contribution plan still needs review. |
| Requested account identity | Verified | Final author and committer match Agent Fleet <myagentfleet@gmail.com>; no upstream submission has been made. |

## Contribution structure and the net-red constraint

The [repository README](https://github.com/commaai/connect/blob/109edb39ffa7a4ad3c38788ca2f39a286538ff07/README.md) asks for best practices, tests, small clean files, and work isolated into contributions that can merge quickly. The reviewed repository inventory contained no tracked AGENTS.md, separate CONTRIBUTING file, or pull request template. The issue's design, platform, and net-red instructions remain applicable; no maintainer waiver was found.

The full comparison contains **48 changed files**, including six new binary fixtures. Binary fixture bytes are excluded from text-line counts.

| Measured category | Additions | Deletions | Net |
| --- | ---: | ---: | ---: |
| Complete text diff | 2,238 | 1,279 | **+959** |
| Tests: paths containing `.test.` | 1,142 | 153 | +989 |
| Non-test text | 1,096 | 1,126 | −30 |
| Production `src/`, excluding tests and `src/api/demo.js` | 901 | 1,083 | −182 |

The subtotals explain the change; they do not exempt tests from the issue's requirement. The legitimate independent demo/fixtures/documentation contribution is too small to make the remainder net red on its own. The review found no credible small cleanup that removes the remaining growth while preserving useful coverage and readability. A verified 51-line removal of dead Media styles/bindings is already included.

A logical review structure is:

- **Reproducible demo support:** deterministic routes, media/sprite fixtures, fixture documentation, and tests that make those routes independently useful.
- **Playback and interaction:** media-driven state, transport lifecycle, recovery, timeline/map behavior, and responsive controls together with their relevant regression tests.
- **Review infrastructure:** source-pinned QA workflows, browser runners, screenshots, and evidence records on the separate QA/review work, outside the application contribution.

This is a proposed review structure, not a claim that splitting files satisfies net-red or that maintainers have accepted the scope. Meaningful regressions should remain with the behavior they protect. Deleting tests, minifying code, or moving files only to change counts would not resolve the underlying requirement.

## What remains before claiming completion

The next acceptance work is to resolve the whole-diff net-red constraint honestly with a maintainable implementation and contribution scope, and to obtain direct physical iOS/Android browser, installed PWA, and iOS audio evidence. The unresolved WebKit/MSE startup observation also needs a bounded disposition supported by measurements. Successful desktop and emulated-native checks should remain attached to their exact environments and source revisions.

The package provides a concrete design and implementation for review, with explicit evidence and limitations. It does not assert full issue resolution or authorize publication upstream.
