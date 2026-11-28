# Offline copy

A person can keep a **read-only copy** of one household on a phone, tablet or
computer. When the device cannot reach the Housetory server, the app shows the
copy. Nothing can be changed until the server answers again.

It is **off** until a person turns it on, and it is for **one device** only.

## What a person sees

**Settings → Offline copy**

- A switch: *Keep a copy on this device*.
- What is saved, when it was saved, and how many photos.
- *Save photos too*, *Update now* and *Remove from this device*.

**Without a connection**

- A line at the top of every page: "Offline. You see your copy, saved today at
  14:02. Changes need a connection." It has a button to try again.
- Items, one item, rooms, one room, storage places and search work.
- Buttons that change something are gone or disabled.
- A page that is not in the copy says "This page needs a connection".
- The assistant, voice and adding items say that they need a connection.

**With a connection again**

- The line goes away by itself. A short "Back online" message shows.
- The pages load fresh data from the server.
- The copy on the device is updated.

## What is in the copy

| In the copy | Not in the copy |
| --- | --- |
| Items with all their fields, also archived items | Documents and their files |
| Rooms, storage places, containers | The purchases, warranties and insurance pages |
| Properties, categories, tags | Loans that are returned or cancelled |
| Loans that are still out (who has what) | Things borrowed from other people |
| One small photo for each item (can be turned off) | History of an item or a place |
| The app itself (its code) | The assistant, stocktake, review, imports, labels |

The copy holds **one household**: the one that is open. After a switch to
another household, the copy is replaced when the device next has a connection.

## Who may keep a copy

The owner chooses in **Settings → Household → Offline copies**:

| Setting | Who may keep a copy |
| --- | --- |
| Owners and members (default) | Not viewers |
| Everyone, also viewers | All roles |
| Nobody | No one |

The server checks this each time a device asks for a copy.

## When the copy is removed

- The person turns the switch off, or presses *Remove from this device*.
- The person signs out. This works without a connection too: the copy is
  removed at once, and the session on the server is ended when the device next
  reaches the server.
- The session ended (password changed, removed from the household). The copy
  is removed when the device next reaches the server.
- The owner no longer allows a copy for this role. Same: at the next contact.
- Another account signs in on the device.
- **30 days** pass without contact with the server.

After sign-out the *choice* stays on the device (not the data). When the same
person signs in again, a new copy is saved by itself.

## Limits, said plainly

- **A copy that is already on a device cannot be taken back from far away.**
  It goes when that device next reaches the server, or after 30 days.
- **The copy is not encrypted by Housetory.** It is as safe as the device.
  Anyone who can open the device and the browser can read it.
- **Read-only.** No change is saved for later. This avoids two people changing
  the same thing while apart.
- **The copy can be old.** The line at the top says when it was saved. Counts
  on rooms and places are from that time.
- **A secure address is needed** (https, or `localhost`). Browsers do not
  allow the needed storage on a plain `http://` address in the home network.
- **Safari on iPhone and iPad** may clear the storage of a website that was
  not opened for some weeks. Adding Housetory to the Home Screen makes this
  less likely. The app asks the browser to keep the storage.
- **The app on the Home Screen is a separate place.** On iPhone and iPad it
  does not share the sign-in or the copy with Safari. Sign in there, and turn
  the copy on there.
- **Photos:** only the main photo of each item, in a small size (up to 480
  pixels). Other photos show a grey box offline.
- **Search offline** looks for the typed text in names, descriptions, brands,
  models, serial numbers, categories, tags, rooms and places. It does not
  answer questions.

## How it works

```
        online                                   offline
  page ──► API client ──► server           page ──► API client ──► copy on the device
                │                                        ▲
                └── after a change, and every few minutes: GET /offline/snapshot
```

### Server

- `households.offline_copy_policy` (`nobody`, `members`, `everyone`). The
  session answer has `offline_copy_allowed` for the current role.
- `GET /api/v1/offline/snapshot` gives the whole household in one answer. Each
  part has the same shape as the normal route (`/rooms`, `/items/{id}` and so
  on). Document text is left out. The answer has an `ETag`; a device that
  already has the same content gets `304`.
- `GET /api/v1/offline/photos/{photo_id}` gives a small WebP of an item photo.
  It is made on request and not stored.
- Both routes refuse with `403 offline_copy_not_allowed` when the policy says
  no. Nothing else on the server changed: there is no write path for offline.

### Web app (`apps/web/src/lib/offline/`)

| File | Job |
| --- | --- |
| `controller.ts` | Knows if the server can be reached. Saves, updates and removes the copy. |
| `resolver.ts` | Answers read requests from the copy, with the same filters and order as the server. |
| `copy-store.ts` | The copy in IndexedDB. The choice and a few facts in `localStorage`. |
| `device-cache.ts` | The app's code and the small photos in Cache Storage. |

- Every request goes through `lib/api.ts`. While the server answers, nothing
  is different. When a request fails because the network failed, and a copy
  exists, the app switches to the copy. Reads are answered from it. Changes
  are refused with "You are offline. Changes need a connection…".
- The device can be "online" and the server still out of reach (not at home,
  VPN off). So the app does not trust the browser's online flag alone. It asks
  `GET /api/v1/health/live` with a short time limit: when it starts with a
  copy, when a read takes longer than 5 seconds, every 15 seconds while
  offline, and when the device or the page comes back.
- `useCanWrite()` is false while offline, so the pages hide their change
  controls as they do for a viewer. A form that was open when the connection
  went away stays open and can be saved later.
- The service worker (`public/sw.js`) opens the app from the device when the
  server does not answer within 3 seconds. It gives the saved small photo when
  a picture cannot be loaded. It never writes API answers to a cache; the page
  saves the copy itself, and only after the person turned it on.

## How it was checked

See "Offline copy record" at the end of this file for the last run.

- Server: `services/api/tests/test_offline_copy.py`.
- Web unit tests: `src/lib/offline/*.test.ts`, `src/components/offline-banner.test.tsx`.
- End to end, production build: `apps/web/e2e/offline-copy.spec.ts`.

## Offline copy record

Done on 28 Nov 2026.

### Decisions, and what each one costs

| Decision | Why | What it costs |
| --- | --- | --- |
| Off by default, per device and per account | The app promised that nothing private is kept on the device. That stays true until a person chooses otherwise | One more step before it is useful |
| Read-only, nothing queued | With several people, changes made apart can clash, and the server has no version check on edits | No adding or moving of items in the cellar without a connection |
| The owner chooses the roles. Default: owners and members | Viewers may be guests | A viewer must ask the owner |
| One snapshot request for the whole household | One consistent read, one place to check permission, the same shapes as the normal routes | The whole household is sent again when something changed. An `ETag` makes "nothing changed" a short answer |
| The API client answers from the copy; pages are not changed | Every page that reads items, rooms and places works without its own offline code | The filters and the search of the server are written a second time in `resolver.ts`. Tests compare them on a small household |
| "Offline" means the server does not answer, not what the browser says | The server is in the home. A phone on mobile data is "online" and still cannot reach it | A small health request, and up to about 3.5 seconds of waiting when the server hangs |
| A failed request alone does not switch to the copy | Something on the device can block one request | One extra health request when a request fails |
| One household in the copy | Simple, and less private data on the device | No switch to another household offline |
| Small photos (480 px), main photo only | The stored "thumbnails" are up to 1600 px. A few hundred of them are too much for mobile data | Other photos of an item show a grey box offline. The server makes the small photo on request (some CPU) |
| Copy removed at sign-out, by policy, and after 30 days without contact | 30 days is the default life of a session on the server | A person who is offline for more than 30 days loses the copy |
| Sign-out works offline | A person must be able to clear a device at once | The session on the server lives until the device next reaches it |
| Requests are always made, also when the browser says "offline" (`networkMode: "always"`) | Otherwise reads wait and changes are sent later without a word | Also for devices without a copy: a change made with no network now fails at once, with a message, instead of waiting |
| A form that is open when the connection goes away stays open | People add items in places with bad signal | While offline that form shows a Save button that answers "You are offline…" |

### What was run

All against the production build behind nginx, in disposable Docker stacks
(`housetory-offline-check`, `-e2e`, `-base`), with their own images and
volumes. The owner's `housetory-test` containers were not touched.

"Server stopped" is `docker stop` of the web container (the connection is
refused). "Server hangs" is `docker pause` (the connection opens and nothing
comes back). The device itself stays online in both. This is the case of a
phone that is not at home.

| Check | Result |
| --- | --- |
| Backend tests (`pytest`, 939 tests) | 937 pass. The 2 that fail (`test_actual_inventory.py`) fail the same way on the commit before this work |
| New backend tests (`test_offline_copy.py`) | 5 of 5 |
| Web type check and production build | clean |
| Web unit tests | 90 files, 703 tests, all pass (30 new) |
| New end-to-end file (`offline-copy.spec.ts`), Chrome | 3 of 3 |

**The 22 offline and reconnect checks** (a script outside the repository):
off by default; turning it on; a page never opened before; a room; a
container; search; an item with its loan and its saved photo; nothing can be
changed; a page outside the copy; the assistant; a full reload without the
server; back to the server with fresh data; the copy updated; a server that
hangs; coming back by itself; the server lost while a list is open; a form
kept and saved later; sign-out; sign-in again; sign-out without the server;
the owner forbids copies; turning it off.

| Where | Result |
| --- | --- |
| Chrome 158 on the Mac, phone size (390 × 844) | 22 of 22 |
| Chrome 158 on the Mac, desktop size (1366 × 900) | 22 of 22 |
| Mobile Safari, iPhone 17 simulator, iOS 27.0 (its first run was the first visit ever) | 21 of 21 |
| Mobile Safari, iPhone 17e simulator, iOS 27.0 | 21 of 21 |
| Mobile Safari, iPad (A16) simulator, iOS 27.0 | 21 of 21 |
| Mobile Safari, iPhone 16e simulator, iOS 26.1 | 21 of 21 |
| Chrome 145, Android 17 emulator | 22 of 22 |
| Housetory installed on the Home Screen, iPhone 17e simulator, iOS 27.0 | all steps pass, see below |

(The Safari run has no "owner forbids copies" step; that one is in the other
runs and in the backend tests.)

**The app on the Home Screen.** Apple's UI test runner (XCUITest) drove a
fresh iPhone 17e simulator with real touches and real typing: sign in in
Safari, Share, "Add to Home Screen", open the app from its icon. The app
opened without Safari's bars and asked to sign in again (its storage is its
own). After sign-in the copy was turned on there: 48 items, 6 of 6 photos.
Then, each time with the app closed fully and opened from its icon:

| Case | What the installed app did |
| --- | --- |
| Server stopped | Offline banner 5 seconds after the tap on the icon; the list, an item, a room; "This page needs a connection" on Documents; the Add button greyed; no edit buttons |
| Leave the app and come back, still offline | Banner and list still there |
| Server started again, app open | Banner gone and "Back online" by itself; copy saved again; edit buttons back |
| Server hangs | Offline banner after 7 seconds; the same pages work |
| Server answers again | Banner gone and "Back online" by itself |
| Simulator restarted while the server was stopped | Offline banner after 7 seconds; a saved photo, the open loan and the search all work |
| Sign out while the server was stopped | Sign-in page at once. App opened again: no items, "can't reach its server" |
| Server started after that sign-out | The first request was the waiting sign-out (the server answered 204). Sign-in page. After sign-in the copy was saved again, because the switch stays on |

Times measured in the browser: the app opens from the device in 1 to 2 seconds when the
server refuses the connection, and in about 3.6 seconds when the server hangs
(3 seconds of that is the wait for the server).

**Did anything else break?** The 54 older end-to-end files were run on this
build and on the commit before it, on the same kind of stack. On one shared
database about 40 tests fail on **both** (they make rooms and items without
naming a household or a property, and an earlier file has added more of
those). The lists of failures were the same, except tests that pass when run
alone. The files that touch what changed here were then run each on a fresh
database:

| File | Result on this build |
| --- | --- |
| `navigation`, `quick-search`, `lending`, `stocktake`, `single-home-polish` | all pass |
| `touch-targets` (now also the Offline copy screen) | 8 of 8 at about 02:10. On the commit before, 1 failed. See the note below |
| `responsive-mobile` (now also the Offline copy row and screen) | 15 of 15. On the commit before, 2 failed |
| `item-status`, `borrowed-items` | 1 test each fails on both builds (sign-in of a viewer made by the test) |

Note on `touch-targets`: run again at about 03:45, three of its tests failed
on **both** builds with the same finding: a link with an item's name in the
Review list is 17 px high. The same tests passed on both builds earlier in the
night, so the finding depends on the data the test makes at that hour. It is
not part of this work and was not changed.

### Found and fixed on the way

- **The switch was 42 px high for a finger** (the touch audit found it). The
  line with the switch is now a label, so the whole line works it.
- **Settings was wider than a 320 px phone** when the e-mail address had no
  place to break. This was there before; it made three older tests fail. Fixed
  with one class.
- **A page that needs the server was shown offline** when the app was opened
  on it. And on a wide screen the list behind an open item was replaced too.
- **Opening the app took 8 seconds when the server hung.** The service worker
  now remembers that the server did not answer and tells the page: 3.6 seconds.
- **A single failed request switched to the copy.** Now the server is asked
  first.
- **A sign-out made offline could be skipped** for 15 seconds after the server
  came back. Now it is tried before every request.
- **A page can be without its service worker** (after a forced reload, or
  when the browser's data was cleared while other tabs were open). Then the
  app could not be opened without the server, and nothing said so. The page
  now asks the worker to take it, and Settings says when the app itself is
  not saved yet.

### What these checks are not

- **Simulators and an emulator, not a phone in a hand.** Real mobile data, a
  real VPN that is off, and a real weak signal were not used. The stopped and
  the paused server stand in for them.
- **The app on the Home Screen was checked on one simulator only** (iPhone
  17e, iOS 27.0), not on an iPad, not on iOS 26, and not on Android. An
  earlier version of this record said this Mac has no Simulator window. That
  was wrong: in Xcode 27 the window is called Device Hub.
- **In Safari, text was put into fields by script**; the driver did not send
  keys on these simulators. Taps were real touches where the page was not
  scrolled (9 to 16 per run) and clicks made in the page where it was (4 to 7).
  On the iOS 26.1 simulator the sign-in request was sent by script, because
  Safari's "Save Password?" box cannot be closed by the driver.
- **Firefox and Samsung Internet were not tried.**
- **Some runs needed a second try because of the test tool, not the app:** a
  tap made while the page was still moving, a button that went away by itself
  before the tool pressed it, and Chrome on the emulator not taking a tap once.
  In the Home Screen run the first tap on "Sign out" came while the page was
  still moving after a scroll and did nothing; with a short wait it worked.
  The numbers above are from the last run of each, on the final code.
- **A large household was not measured.** The test household has 48 items; its
  snapshot is 87 KB. A few thousand items mean a few megabytes for each update.
- **Safari clearing storage after weeks without a visit** was not waited for.
- **Two tabs:** a copy removed in one tab is dropped by the other. A copy
  turned on in one tab is not shown as "on" in the other until it is reloaded.

### How to run the new end-to-end file

It needs the production build (the service worker). Against the development
server the tests skip themselves.

```bash
cd apps/web
E2E_BASE_URL=http://localhost:8090 npx playwright test e2e/offline-copy.spec.ts
```
