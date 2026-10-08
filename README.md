# comma connect

The web and mobile companion application for [openpilot](https://github.com/commaai/openpilot)

Try it with your openpilot device:
- **stable:** https://connect.comma.ai
- **latest:** https://latest.connect-d5y.pages.dev/

## Development
* Install bun: https://bun.sh/docs/installation
* Install dependencies: `bun install`
* Start dev server: `bun start`
* Demo mode: Navigate to `/demo` to test locally without a comma device.

API and useradmin URL roots can be overridden at build time with
`VITE_COMMA_URL_ROOT`, `VITE_ATHENA_URL_ROOT`, `VITE_BILLING_URL_ROOT`, and
`VITE_USERADMIN_URL_ROOT`. Docker Compose accepts the same variables.

### URL navigation

`src/url.js` is the URL contract. Navigation actions in `src/actions/navigation.js`
only update browser history. `src/actions/history.js` handles every location change
(including Back and Forward), applies the parsed navigation through
`src/reducers/navigation.js`, and loads any missing data through `src/actions/routes.js`.
Components read `state.navigation` instead of maintaining separate page flags.

| URL | View |
| --- | --- |
| `/`, `/<dongle>` | Dashboard |
| `/referrals` | Referrals |
| `/<dongle>/prime`, `/<dongle>/stream` | Subscription or live stream |
| `/<dongle>/<log>` | Whole drive, including newly uploaded segments |
| `/<dongle>/<log>/<start>/<end>` | Fixed selection, in relative seconds with up to three decimal places |
| `/<dongle>/<startEpochMs>/<endEpochMs>` | Legacy selection, converted to a drive URL |

Major dialogs use `?dialog=<name>` over their parent page. Supported names are
`settings`, `unpair`, `pair`, `filter`, `uploads`, `clips`, `clip`, `delete-clip`,
`downloads`, `route-info`, `cancel-prime`, and `change-plan`; the dialog definitions
in `src/url.js` specify their allowed pages, device requirements, and parents.
Settings, unpair, and uploads can target another device with `&device=<dongle>`.
Uploads opened from settings add `&parent=settings`; closing them returns to
settings and keeps its unsaved form state mounted. Unpair also returns to settings.
Clip viewing and deletion use `&clip=<filename.mp4>` and return to the clips menu;
the filename is resolved against the device's inventory before use.
The legacy `?pair=<token>` link opens the same pairing dialog as
`?dialog=pair&pair=<token>`. Its transaction is reused across Back and Forward,
so returning to its result does not repeat the pairing request.
Dialog navigation preserves the page, selected range, unrelated query parameters,
and history metadata. Forms and operation progress remain component state.

Route metadata is cached by the full `dongle|log` identity, separately from each
device's dashboard list and filter. Pending requests are reused when navigating
away and back. Responses for inactive devices still populate the cache; dashboard
membership changes only when the requested filter and limit still match, and
older responses cannot overwrite newer route metadata. Missing or failed drives
show a settled result with an explicit Retry action.
A dialog-only location change keeps playback and loaded data intact. In-app zoom
navigation stores its predecessor in browser history state; a direct selection
link can always zoom out to the whole drive.
When adding a route, update the parser/formatter, the view, and URL/history tests.

## Contributing

* Use best practices
* Write test cases
* Keep files small and clean
* Use branches / pull requests to isolate work. Don't do work that can't be merged quickly, find ways to break it up

## Libraries Used
There's a ton of them, but these are worth mentioning because they sort of affect everything.

 * `React` - Object oriented components with basic lifecycle callbacks rendered by state and prop changes.
 * `Redux` - Sane formal *global* scope. This is not a replacement for component state, which is the best way to store local component level variables and trigger re-renders. Redux state is for global state that many unrelated components care about. No free-form editing, only specific pre-defined actions. [Redux DevTools](https://chrome.google.com/webstore/detail/redux-devtools/lmhkpmbekcpmknklioeibfkpmmfibljd?hl=en) can be very helpful.
 * `@material-ui` - Lots of fully featured highly customizable components for building the UIs with. Theming system with global and per-component overrides of any CSS values.
 * `connected-react-router` - Mindlessly simple routing with convenient global access due to redux
