# Photo Map

A local photo heat map. Points your photo folders at an index, reads GPS and capture
time out of EXIF, and gives you a world map, a browsable gallery, and time-series tools
on top. Nothing leaves the machine except map tile requests.

## Run

Double-click `run.bat`, or:

```bash
.venv\Scripts\python.exe serve.py --lan
```

The browser opens at http://127.0.0.1:8712. Drop `--lan` to keep it local-only.

First launch: the settings dialog opens, add the folder holding your photos
(Browse or paste a path), close it, then press **Scan library**.

Fresh checkout instead of the bundled `.venv`:

```bash
python -m venv .venv && .venv\Scripts\pip install -r requirements.txt
```

## Using it from your phone and laptop

`--lan` binds every interface and prints the addresses other devices can use, plus a
QR code for the first one:

```
  On your phone or laptop (same Wi-Fi):
    http://192.168.1.24:8712/?k=wyxroSdp1gZf

  Access key: wyxroSdp1gZf
```

Scan the QR or open that link. The same links are in **⚙ → Open on another device**,
with copy buttons.

**Windows Firewall will block the port until you allow it.** This is the usual reason a
phone cannot connect. In an **administrator** PowerShell, once:

```powershell
New-NetFirewallRule -DisplayName 'Photo Map' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8712 -Profile Private
```

`-Profile Private` keeps it to networks marked Private - it will not open the port on a
public café network. If your Wi-Fi is set to Public, either change it to Private in
Windows network settings or the rule will not take effect.

### Access key

Sharing over the network exposes the library, the folder browser and the delete
endpoints, so anything that is not on loopback has to present a key:

- The printed link carries `?k=<key>`, which is swapped for a cookie on first load, so
  the key stops appearing in the address bar. Devices stay signed in for a year.
- Typing the address by hand shows a small unlock page instead.
- Requests from the machine running the server never need it.
- **⚙ → New key** (or `serve.py --new-key`) revokes every signed-in device.

This is a shared-secret gate for a home network over plain HTTP, not encryption. Anyone
on your Wi-Fi who has the key can browse and delete photos, and traffic is unencrypted.
Do not port-forward this to the internet.

### Phone and tablet

The layout adapts below 860px: the sidebar becomes a drawer behind ☰, the gallery drops
to three columns, and hover-only controls (select circles, album actions) become
permanent. The timeline brushes with a finger, and the lightbox advances on swipe.
Box-select is hidden on small screens since it needs a drag the map already uses for
panning.

Map tiles and the Leaflet libraries load from the internet, so a device on the Wi-Fi
also needs a working connection - thumbnails and data come from your machine.

This is the LAN app, and it only exists while this computer is on and on the same
network. For a phone that works anywhere, install the published viewer instead - see
[On a phone, without this computer](#on-a-phone-without-this-computer).

## What it does

**Map** - heat map, marker clusters, or raw points, over dark / streets / satellite
basemaps. Zooms to z22 (tiles over-zoom past their native resolution, so you can push
in closer than the imagery). `Path` connects photos in capture order. `Box select`
(or shift-drag) selects everything inside a rectangle, on the globe as well as the flat
map. The two answer it differently: the flat map turns the corners into a lat/lon box
and asks the server, which catches photos scrolled off the edge of the pane; the globe
cannot, because a rectangle drawn on a sphere is not a rectangle in coordinates - near
the limb it bends, and over a pole the corners bound nothing. It asks the renderer which
dots it actually drew in those pixels instead, which also leaves out the ones on the far
side of the planet: they are behind the globe, not under the box. Hovering a marker previews the
thumbnail; clicking opens the photo.

`Colour by day` (points and globe) gives every capture day its own colour, so a single
place stops being one blue blob and separates into the visits that made it. Hues step by
the golden angle rather than running along a gradient, which is what keeps consecutive
days apart instead of nearly identical. The status line counts the days on screen.

The heat map's radius, blur and intensity are remembered between sessions. They live in
the settings table rather than in the browser, so they follow you to the phone; the
`value` attributes in the HTML stay the defaults, so there is one place to change those
rather than two. The write waits for the slider to stop moving.

**Journal** - a note per calendar day, written the way a word processor works:
**Ctrl+B / I / U** for bold, italic and underline, **Ctrl+Shift+7 / 8** for a numbered or
bulleted list, **Ctrl+Shift+X** to strike through, and typing `- ` or `1. ` at the start
of a line turns it into a real list. **Tab** makes the current point a sub-point of the
one above it and **Shift+Tab** promotes it back - only inside a list, because everywhere
else the browser's indent is a style attribute, and attributes do not survive being
saved, so the indent would look right until the day was stored and then vanish. Outside a
list Tab keeps its usual job of moving to the next control, which is the only way out of
a note by keyboard; **Escape** also leaves, and saves.

The list shortcuts are read off the physical key rather than the character, because the
character depends on the layout: shift-7 is `&` on a US keyboard.

Entries are stored as HTML, so everything read back out of the database - or pasted in
from elsewhere - is rebuilt from a whitelist of tags that cannot carry an attribute. The
parsing happens in an inert `DOMParser` document rather than a live element, so markup
cannot run while it is being taken apart.

The whitelist is walked over a live node list rather than a snapshot, which is the part
that makes it a whitelist at all. Unwrapping a tag that is not on the list moves its
children up a level, and those children have not been checked yet; scrubbing them where
they used to be - inside the tag just removed - looked one level too deep and let
anything wrapped in a rejected tag through whole. `<span><img src=x onerror=...></span>`
lost the span and kept the img, handler and all, which since notes go back on the page
with `innerHTML` was one copied paragraph away from running in the app's own origin.
Continuing from the first promoted node instead means every node is tested in its own
right, however deeply it was buried.

Every day exists whether or not anything was written in it, so the list runs backwards
without end: today at the top, then an *Earlier* divider, then a month at a time as you scroll. Only the days that have text come from the
server - the empty ones between are made locally, which is what keeps a decade of journal
from being a decade of rows. **Go to day** jumps the list to any date rather than making
you scroll to it, and **Back to today** returns. Clearing an entry deletes it - a blank
day is not worth keeping.

Entries save a couple of seconds after you stop typing, and again when you click away.
They used to reach the database only on the way out of the field, which put an afternoon
of writing one closed tab away from being gone. The card says *Saving…* and *Saved* in
its own header rather than raising a toast, because a toast every few seconds while you
write is not feedback, it is weather.

Searching drops the continuum and lists only the days that match, since a search is a
search of what was written, not a walk back through empty days.

Saving redraws only the card it saved. Rebuilding the list would replace every editor
on the page, so moving from one day straight into another threw away what you had just
started typing in the second one; a redraw asked for while the caret is in a card is now
held until it leaves.

Every day is located automatically as it saves: if it has no location yet, the device is
asked (silently - never twice if you have said no), and failing that the server places it
by the photo nearest in time. The buttons only override that: **Use my location** forces
the device, **Set on map** drops you on the map to click the spot. The nearest-photo
fallback is capped at two days out, because a photo from six months later says nothing
about where you were. The card says which route it used, and **Show on map** jumps there. `Notes` on the map plots every
located day as a pin you can open; it sits outside the photo filters on purpose, since
hiding a note because the date range moved would be surprising. The search box filters the
journal alongside the photos.

Browser geolocation only works in a secure context, which over plain HTTP means localhost
and nothing else - so **Use my location** works on this computer but not from a phone on
the LAN. That is what the nearest-photo fallback is for.

**Photo notes** - the lightbox has a note field under the photo details. It saves when you
click away (or Ctrl+Enter), and the search box searches note text alongside filenames
and paths, so "broken bike" finds the photo you wrote that on. Every view respects it:
searching a note narrows the map, the timeline and the gallery together. Photos with a
note carry a ✎ in the gallery. Notes are stored in the local index, not written into
the image files. They are published to the cloud snapshot, and can be written from it -
see [Changes made in the cloud](#changes-made-in-the-cloud).

**Light and dark** - the ☀/☾ button in the top bar flips between them, and it names
what you would get rather than what you have. **⚙ → Theme** adds the third option,
*Match system*. The whole stylesheet is written against CSS variables, so a theme is one
block of values rather than a second stylesheet. The choice is stored in the database, so
it follows you to the phone, and mirrored into `localStorage`, so the page can stamp
`<html>` before the first paint instead of flashing the wrong theme. The basemap moves
with it - a black map under a white UI reads as a bug.

**Timeline** - histogram across the bottom, always live. Bright bars are photos with
GPS, dim bars are the rest. Drag to select a date range and everything else filters to
it; `▶` sweeps a moving window across the whole library and animates the map.

**Gallery** - infinite grid, adjustable tile size, five sort orders. Click opens the
lightbox, ctrl-click toggles selection, shift-click selects a range. The selection bar
adds to albums, favourites, shows on the map, or deletes.

**Globe** - a fourth map mode rendering the same points on a 3D globe, on MapLibre GL
JS's globe projection. Hover a point for its thumbnail, click to open it. Capped at
120,000 points, the same ceiling as the 2D points layer.

The preview sits over the photo it belongs to, clamped to stay inside the pane, and waits
for the pointer to settle before it appears: sweeping across the globe crosses dozens of
photos, and showing each one fired a thumbnail request per photo crossed. It asks for the
256px thumbnail the gallery already caches rather than a size of its own, so a hover is
usually a cache hit instead of the server decoding a full-size photo to make one more.

Three skins, *Map*, *Streets* and *Satellite*, streaming the same tiles as the 2D map's
three basemaps. All three live in the style at once and are switched by visibility:
MapLibre only fetches tiles a visible layer uses, so a hidden skin costs nothing, the
visible one keeps what it had cached when you switch back, and the attribution line
follows on its own. CARTO's `@2x` tiles are asked for only where the display can show
them; raw OpenStreetMap tiles, behind *Streets*, do not offer a retina set to ask for.

`Path` works here too: its own line layer, drawn under the points rather than over them,
so the dots it connects stay legible instead of getting a dashed line drawn across them.
Capture order comes for free - `/api/points` already returns photos sorted by
`taken_ts` - so this draws straight off the arrays it is given, with no sort of its own.

`globe` is a projection preset rather than a mode: a sphere out to zoom 10, easing into
mercator by 12, which is where a sphere's floating-point precision runs out anyway. So
zooming in stays a map and there is no cliff between this mode and the 2D one.

This used to be a three.js sphere with slippy tiles stitched onto it by hand, and it
froze. The engine under it freed the levels you came through only when you zoomed back
*out*; zooming *in* pushed them behind the current one with depth writing off, so a dive
from the whole planet to street level left every level resident, each tile a megabyte of
`@2x` texture, until the GPU gave up. What replaced it is not a better bound on that leak
but the absence of one to bound: the tile pyramid and its eviction, the point rendering,
hit testing and the camera are all MapLibre primitives now - the same machinery that
draws an ordinary map. Zooming from world view to z18 and back three times over holds
between 10 and 55 live GPU textures and a flat 27-31MB heap, with no code here counting
either. The old build policed a ceiling of 120 textures by hand, and the purge it used to
stay under that ceiling moved the camera, which fired the zoom handler, which called the
purge again.

Two more things fall out of using a real map renderer. It draws on demand instead of
running a frame loop, so an idle globe costs nothing; and a photo is a feature in a
circle layer, which means MapLibre knows which one is under the cursor. Hit testing used
to be a raycast onto the sphere followed by a nearest-point search across every photo on
every pointer move.

MapLibre is around half a megabyte and most sessions never open this mode, so it is
imported from `frontend/vendor/` the first time the mode is chosen rather than at boot - which is why the pane
says *Preparing the globe…* for a moment on first use, and why nothing at all is loaded
for it otherwise. It needs WebGL2; if that or the CDN is missing, the status line says so
rather than leaving a blank pane.

Readiness is taken from `style.load` rather than `load`, because `load` also waits for
the first painted frame and a background tab is given no frames at all. Leaflet keeps its
own controls above everything in the pane, so the 2D map is hidden - not removed, or it
would lose track of its size - while the globe is up.

**Capture times** - EXIF first, then the filename, then the file's modified date. That
order is measured, not assumed: across a 26,729-photo library EXIF disagreed with the
filename twice, while the file date disagreed 2,945 times out of 5,833 (median error 164
days). `backend/nametime.py` reads the common camera, WhatsApp, Signal and screenshot
formats, and strips the ` (YYYY_MM_DD HH_MM_SS UTC)` suffix Google Takeout appends -
that is the *export* moment, and taking the last date in the name would stamp every
photo with it. **⚙ → Fix dates from filenames** applies it without a full rescan.

Rules rather than a model on purpose: the formats are a short closed set, so regexes are
exact, instant, offline and free. `nametime.unmatched()` lists names no rule covers, if
new formats turn up.

**Duplicates** - the Duplicates tab finds byte-identical copies. `Select page` ticks the
sets in front of you; `Select all sets` ticks every set in the library, after telling you
how many files and how much space that is. Both only tick - one copy of each set always
survives, and nothing moves until you press the delete button. Files are grouped by
size first (two files cannot match unless their sizes do), so only the collisions are
read: on a 99.5GB library that meant hashing 20.5GB, 79% less I/O, in about 18 seconds.
Matching uses a full SHA-256 rather than a sampled hash, because the result drives
deletion. Each set proposes one copy to keep - favourites, copies that still have GPS,
and names without `(1)`/`copy` markers win - and you can pick a different one. Extras go
to the recycle bin; the API refuses any set that would not leave exactly one survivor.

**Albums** - manual grouping. Each album has a colour that the map uses for its points,
so a single album can be visualized on its own. Build one from a selection, or empty.

**Insights** - totals, GPS coverage, disk usage, and distributions by hour of day,
weekday, month, year, plus a camera breakdown. Respects the active filters.

## Deleting

Two modes, chosen every time:

- **Move to recycle bin** - the file goes to the OS recycle bin (via Send2Trash) and
  leaves the library. If Send2Trash is unavailable the file moves to `data/trash/`.
- **Remove from library only** - the index entry goes, the file stays on disk. The next
  scan will pick it up again.

Nothing is ever hard-deleted.

## How dates are handled

EXIF capture times carry no timezone. A photo taken at 15:00 in Tokyo and one taken at
15:00 in Paris are both stored as 15:00 and both display as 15:00. Internally the wall
clock is normalized through UTC so it sorts and buckets correctly. Photos with no EXIF
date fall back to the file modification time, marked "(file date)" in the lightbox.

## Formats

Whatever Pillow can open in your environment: JPEG, PNG, TIFF, WebP, BMP, GIF, and AVIF
natively. HEIC/HEIF needs `pillow-heif` to load successfully - the settings dialog shows
whether it did. RAW files are not indexed.

> On this machine `pillow-heif` installs but its native library is blocked by an
> Application Control policy, so `.heic` is currently not in the indexed set. Everything
> else works. If that policy changes, HEIC turns on with no code change.

## Third-party libraries

Leaflet, its cluster and heat plugins, and MapLibre are served from
`frontend/vendor/`, not a CDN. They used to come from unpkg, which meant this - a local
tool, pointed at a local library, needing the internet only for basemap tiles - would not
start at all if unpkg was down or blocked. The files are the published ones, unmodified,
at the versions the app was written against; `frontend/vendor/README.md` lists them and
says how to upgrade. There is no build step and no lockfile: what is in that folder is
what the browser runs.

Map tiles are still remote and cannot be otherwise - CARTO, OpenStreetMap and Esri, and
the app would have to ship the planet. A tile outage leaves the map blank but the app
running, which is the difference between that and the problem above.

## Portable cloud gallery

Publishes the library -- map, gallery, albums, duplicates, insights and a small
thumbnail per photo -- to a **private** Cloudflare R2 bucket, served through a
password-protected Worker. Once synced it works from any browser with this computer
switched off. Full-size originals never leave the machine.

**Publish scope** (⚙ → Portable cloud snapshot): *whole library* gives map **and**
gallery; *only photos with GPS* gives a map-only heat map and uploads far less. The
dialog shows the estimate live -- on a 26,729-photo library, 160px thumbnails come to
about 313MB, roughly 3% of R2's 10GB free tier.

Thumbnails are content-addressed, so a routine sync rewrites only `manifest.json` -- a
handful of Class A operations against a 1M/month free allowance.

The first publish has to generate a thumbnail for every photo, which is the slow part:
roughly 13 minutes for 26,000 photos. Later syncs only touch what changed.

### On a phone, without this computer

The published viewer installs. Open the Worker address on the phone and take
**Install** (Android/Chrome) or Share → **Add to Home Screen** (iOS); it then launches
from the home screen with no browser chrome. The desktop app can be off, asleep, or on
another continent -- the phone talks to the bucket, not to it.

That is the whole point of the split. The app on this computer needs this computer: it
serves its own thumbnails and its own index over the LAN. The published viewer needs
nothing but the bucket, so it is the one that gets installed.

**The map modes are all there now**: heat, marker clusters, canvas points and the 3D
globe, over dark / streets / satellite basemaps, with `Path`, `Colour by day` and the
heat radius / blur / intensity sliders. Clustering is capped at 60,000 photos and falls
back to the heat map past that; points cap at 120,000, the same ceilings the desktop
uses. Box select is a drag on the flat map, answered here in the browser rather than by
a server - the viewer already holds every point in memory, so there is nothing to ask.
It is hidden below 768px, where that drag is how you pan.

The libraries are served from the bucket under `vendor/`, the same builds the desktop
runs, rather than from unpkg. That was not only a robustness preference: a cross-origin
script is one the service worker is not allowed to cache, so the installed app had a
page and no map at all the moment it went offline - the exact case it exists for.
MapLibre is deliberately left out of the precached shell, being half a megabyte for a
mode most sessions never open; it is fetched the first time the globe is chosen and
cached from then on.

**Insights in the viewer** are computed in the browser from the manifest rather than
asked of a server, because there is no server to ask - the Worker serves objects and
nothing else. Totals, GPS coverage, disk usage and the distributions by year, month,
weekday and hour all fall out of arrays the snapshot already carries, so the whole view
costs one pass over the photos already in memory and works offline like the rest of the
app. They follow the active filters, so narrowing to an album or a date range reshapes
them the way the desktop's Insights tab does.

Two fields exist only to feed it: `sz` (per-photo bytes) and `cam` (an index into a
`cams` list, since a camera name repeats across thousands of photos and interning it
costs a few hundred bytes rather than a megabyte). That is manifest version 3; a viewer
loading an older snapshot shows everything except disk usage and cameras, and says which
sync would fill them in, rather than drawing an empty card.

Buckets are cut in UTC, matching `strftime(..., 'unixepoch')` on the desktop side. Local
time here would put the same photo in a different hour on the phone than on the laptop.

**The gallery is virtualised, and has a date rail.** Only the screenful in view exists
as DOM: the grid is uniform, so a photo's box is arithmetic rather than layout, and
26,000 photos cost about forty tiles instead of 26,000. That is also what makes the rail
possible -- a month can only be mapped to a scroll offset if the whole list has a height.
The rail is the strip down the right edge: drag it and the gallery scrubs, with a bubble
naming the month under your finger. Labels sit at the offset of the first photo of each
year, months fill whatever gaps are left wide enough to read, and a drag lands on the
start of the nearest month, because one pixel of a full rail can be forty photos and a
tap on `2022` that answered `Jan 2023` would be a lie. Tiles are not repainted during the
drag - a scrub across ten years would otherwise ask for a thumbnail from every month it
crossed - so the window is drawn when you let go. It follows the filters like everything
else: narrowing to an album or a date range rebuilds the rail around what is left.

Below 768px the viewer rearranges: the view tabs move to a bottom bar within thumb
reach, filters slide up as a sheet over the map (so the map keeps redrawing behind them
while you drag the time range), and the delete confirmation goes edge to edge. The top
bar goes entirely -- the title, the tabs and the summary were all hidden there anyway, so
it was 46px holding nothing -- and the map takes the space, running to the top edge of
the screen. Its row collapses to zero rather than to the safe-area inset: a phone that
reports one (any Android drawing edge to edge, not only a notched iPhone) would otherwise
still show a band of panel colour under the status bar, which is the strip that was worth
removing in the first place. The inset is then paid by whatever would sit under the
status bar instead -- the map's controls, the date rail, the scrolling views, and the
**Offline** and **Install** chips, which float over the view now that there is no row to
hold them. There is no sign out button: signing out of a private app on your own phone is
not something anyone does often, and on a phone there is no longer a bar to put it in.
Visiting `/__logout` still clears the session.

The search box filters filenames and note text together, the same one-box rule the
desktop uses, and every view answers it - map, globe, gallery and insights all read the
same filter. Searching costs the snapshot one filename per photo: 1.2MB of text, which
is about 119KB once the edge compresses it, since filenames share long prefixes.

A service worker makes it work with no signal at all:

- the page, its icons and `manifest.json` are fetched network-first and fall back to
  the last copy, so the app opens offline with the snapshot it last saw;
- thumbnails (`t/<hash>.jpg`) are content-addressed -- the bytes under a name never
  change -- so they are served cache-first, which also makes a second visit instant.
  The cache is trimmed to the 4,000 most recent, around 50MB;
- `/api/` and the password gate are never cached. A queued favourite or album change
  has to reach the Worker, and the viewer says so plainly rather than pretending it
  saved;
- a 401 is a successful response, not a failure, so the login page is never cached in
  place of the app.

**Map tiles are the exception**: they are cross-origin and stay uncached, so offline you
get your points over an empty background rather than a basemap.

`manifest.webmanifest` and the icons are the only objects the Worker serves without a
session, because the browser fetches them with no cookies when deciding whether the app
is installable. Gating them would leave the app quietly uninstallable while looking
fine. They say nothing about the library.

### Changes made in the cloud

The viewer can favourite photos, write photo notes, add them to albums, create albums,
and remove duplicate copies. A note saves on the way out of the field (or Ctrl+Enter),
and only when it actually changed, so opening a photo to look at it queues nothing. An
empty note clears it, stored as NULL exactly as the desktop does, so the search never
matches a blank. Notes are capped at 4,000 characters in the Worker, with the same cap
again on the desktop side for objects written before it existed.

It never writes to the library directly: each change is parked in the bucket
under `inbox/`, and the desktop app drains and applies it on its next sync. Every
operation is idempotent, so a change whose inbox object failed to delete does no harm
when it is seen again, and an unrecognised operation is ignored rather than guessed at.

**Duplicate cleanup** is always available: it is refused unless exactly one copy
survives, so it cannot lose a photo.

**Deleting ordinary photos** is off until you switch it on in ⚙ → *Allow deleting photos
from the cloud*. Once on, several things have to line up before a file moves:

- the viewer shows the actual photos and asks for confirmation; deleting more than one
  requires typing the exact number;
- the request must state how many photos it means to delete, and the desktop side
  refuses it if that count does not match the id list;
- batches are capped at 200, so a malformed or replayed request cannot sweep the library;
- the change sits in the queue until the next sync, and the viewer offers **Undo** for
  fifteen seconds, which removes it before it is ever applied;
- files go to this machine's recycle bin, never straight to permanent deletion;
- the desktop re-checks the switch when applying, so a snapshot published while it was
  on cannot be used to delete after you turn it off.

### Adding photos from a phone

Off until you switch it on in ⚙ → *Accept photos added from your phone*. Once on, the
viewer grows a **+ Add** button. A picked photo is pinned straight away from an EXIF
read in the browser, uploaded as a small proxy and then as the full-resolution
original, and collected by this computer on its next sync into `data/imported/`, where
it becomes an ordinary library photo. The desktop re-reads every file it receives with
Pillow and wins any disagreement with the phone, so a phone that could not parse its
own HEIC still ends up with real coordinates.

**Select everything, every time.** No web app can reach a camera roll without the
phone's own picker, so choosing the photos is a gesture only you can make -- but
choosing *which* photos is not, and picking the lot is the intended way to use it.
Anything already in the library is passed over, in three places:

- the phone remembers the fingerprint of every photo it has handed to the bucket -
  name, size and modified time, which costs no reading at all, and the digest of the
  bytes, which still recognises the same photo offered under a different name. That
  memory deliberately outlives the upload record itself, which is dropped as soon as
  this computer has collected the photo;
- the snapshot already publishes a filename and a byte count per photo, so a photo
  copied off this phone by cable months ago is recognised without asking anything of
  the network;
- and the desktop refuses to file an upload whose bytes it already has, wherever it
  came from and whatever it is called now. That is the authority - the phone's two
  checks only save the upload.

Photos are read one at a time and sent as they are read, rather than the whole
selection being decoded up front: a five thousand photo roll staged in one go is
several gigabytes of previews parked on the phone waiting to be collected, which is
the phone's storage quota rather than anything this app could apologise for. If the
queue stops moving -- no signal, or the bucket full -- reading stops rather than
filling the device, and the viewer says how many it did not reach. Picking again costs
nothing, since by then everything sent is skipped on sight.

Uploads are bounded in the Worker, before any bytes land: 64MB per photo, 2MB per
proxy, and a 4GB ceiling on everything waiting. Past the ceiling it answers 507 and the
viewer says uploads are paused until this computer syncs, rather than failing quietly.
One photo per request, since the largest body a Worker can receive is 100MB on the Free
and Pro plans.

**Only on Wi-Fi**, by default - photos are the one thing here big enough to matter on a
phone plan. The queue holds on mobile data and goes by itself the moment Wi-Fi comes
back, with no second visit to the app. What the phone will admit decides whether this
can be honoured at all: `navigator.connection` is Android's, Safari has never shipped
it, so on an iPhone the connection type is simply unknown. Unknown sends rather than
blocks - a switch that silently stops everything forever is worse than one that cannot
be enforced - and the sheet says which of the two you are looking at instead of implying
a guarantee it cannot make.

**When a photo has no pin, it says which of four things happened**, because they want
opposite reactions and had all been reported as the same silence: the file is a HEIC
this phone cannot read but the computer can; it has a GPS block with no fix in it, so it
was taken without a location; it has EXIF but *no GPS block at all*; or it has no EXIF
whatsoever.

The third of those is the one worth knowing about, and the distinction is what makes it
diagnosable. A camera does not write a file with the GPS block missing - a photo taken
without a fix still has the block, empty - so a *missing* block means something removed
it in transit. That something is the phone's own photo picker: **Android redacts the
location from every photo it hands an app that cannot ask for it**, which includes the
browser. The file on the phone still has its coordinates; the copy the page receives
does not, and no amount of reading it harder will find them.

So there are two ways in. **+ Add photos** is the photo picker: convenient, and on
Android the location is stripped. **+ From files** is the same flow through an input with
no `accept` at all, which sends the chooser to the file browser instead - a photo read as
a document arrives whole. Which one your phone needs is not a guess any more: add a few
either way and the result panel says whether they came through located.

`viewer/exif.js` was measured against 40 real photos out of this library - Samsung,
HONOR, FOSSiBOT - and agreed with Pillow on every one to within 1e-4 degrees, which is
how the picker rather than the parser was identified as the thing losing them.

**Collecting carries on with the app closed.** `collect.py` is one pass - look, sync if
there is anything new, exit - and `python collect.py --install` registers a Windows
scheduled task that runs it every 15 minutes. It stands down when the app is open, since
the app is already watching and two processes draining one inbox is worth avoiding; it
tells the two apart by whether anything is listening on the app's port. The record of
what has already been seen lives in the database rather than in memory precisely so the
two agree.

    python collect.py              one pass, then exit
    python collect.py --install    every 15 minutes, app open or not
    python collect.py --remove     stop that

**The computer collects them by itself.** While Photo Map is running it looks in the
bucket every 60 seconds and syncs when it finds anything - a photo, a favourite, an
album - so nothing waits for someone to press Sync. Idle it transfers nothing: two
prefix listings, about 90,000 Class A operations a month against a million-a-month
allowance. It tracks keys rather than counting them, which is the part that matters: an
import whose full-resolution half has not arrived keeps its inbox key on purpose, so
counting would find work every minute and sync in a loop forever. A new key is new work,
and the arriving `.orig` is itself the new key that gives that import its next try. It
is ⚙ → *Sync by itself when the phone adds something*, on by default.

**And the phone notices when they land.** The viewer re-reads `manifest.json` every 20
seconds while photos of its own are still out there - never otherwise, and never while
the screen is off - and swaps in a newer snapshot without touching the view you are
looking at. The amber pin becomes an ordinary library photo on its own, and it says so.
Together with the watcher, a photo picked on a phone is in the library and on the map
about a minute later with nothing pressed on either device.

**Original files, not the picker's copies.** The `accept` list names `.heic`/`.heif`
rather than `image/*` alone, and that one line decides whether a photo arrives with a
location on it: asked for `image/*`, iOS transcodes a HEIC to JPEG on the way out of the
picker and the copy it builds has the GPS tags stripped, so the file reaching the bucket
has no position and nothing downstream can put one back. Naming the extensions makes it
hand over the original untouched. The cost is that `viewer/exif.js` is JPEG APP1 only
and cannot read a HEIC, so those get their pin when the computer files them rather than
the instant they are picked - a real location a minute later against none at all. A
preview still has to be made from the file either way, so `downscale` falls back from
`createImageBitmap` to an `<img>`, which reaches decoders the former does not.

Where the file itself has neither, the desktop keeps **what the phone read**. It already
did that for the position; it now does it for the capture time too, and the distinction
is not academic: when only the proxy survives, the proxy is a canvas re-encode carrying
no EXIF at all, so the capture time would otherwise fall back to the file's own date -
the moment it was written on the computer. That reading is stored as `taken_src=phone`,
and anything the file actually carries still outranks it.

**Adding photos lives in Settings**, the ⚙ tab in the bottom bar - the button and the
upload state, not just the filters, which is why that tab is no longer called Filters.
Below 768px there is no top bar at all, so anything left in it floats over the map next
to the map's own controls, which is where both of them used to sit. The tab carries a
dot when an upload needs attention, since the sheet is shut most of the time.

**A photo can upload perfectly and still not be on the map**, and the reason is
coordinates rather than anything going wrong. The viewer reads EXIF itself so a pin can
appear before the upload finishes, but `viewer/exif.js` only parses JPEG APP1: a HEIC
carries none it can read, and a phone may hand over a copy with the location stripped.
Those photos are sent, and the desktop reads their real coordinates with Pillow when it
files them, so they appear a sync later. Until then the status line says how many are
waiting on a location rather than leaving them silently missing, and the result panel
says it too.

Photos added here are drawn on the **globe** as well now. They were only ever drawn on
the flat map, so a session that had last used Globe - which the viewer remembers between
visits - showed nothing at all for a photo that had just been added.

Nothing here says "waiting for your computer" any more. It reads as a fault when the
computer is switched on and in front of you; what it meant was that Photo Map has to run
a sync before an uploaded photo joins the library, so that is what it says.

**A progress bar while it runs, and a result panel afterwards.** The bar names the photo
in flight and fills with the bytes actually delivered - `XMLHttpRequest`, not `fetch`,
which has no upload progress event at all - so a 50MB photo over a bad signal is
visibly moving rather than apparently hung. **Stop** ends the run and aborts the request
in flight; nothing queued is lost, and picking again skips whatever already went.

The panel that follows says what happened and, when something failed, why - and it
stays until dismissed, because a toast is three seconds long and a reason is worth
reading twice. Reasons are grouped, so forty photos that failed the same way are one
line rather than forty, and it offers **Retry**, which re-sends the failed records
without re-reading the camera roll.

Every failure carries its status code, which is the fix for a specific and bad silence:
the old code reported `data.error || r.statusText`, and *both halves are empty* for the
answers this actually gets. A non-JSON body - a Cloudflare error page, a Worker with no
import route, an expired session's login page - leaves the first empty, and HTTP/2,
which is what Cloudflare speaks, has no status text at all, so the second is empty
always. Every one of those arrived on screen as "could not send" and nothing else. The
common ones are now named outright: an expired session, a 413, a 507, and a **405 or
404 on `/api/import`, which means the Worker predates the import routes and needs
`wrangler deploy`** - a snapshot sync publishes the viewer to the bucket but never
deploys the Worker, so that one is easy to hit and was impossible to diagnose.

A run also stops on the first failure that will repeat - an expired session, a missing
route, a server error, a dropped connection - instead of grinding a whole camera roll
into the same wall. Failures that belong to one photo, like a 413, only skip that
photo. And a connection that stops moving for 60 seconds is treated as gone rather than
slow: an absolute timeout cannot tell those apart, but bytes arriving can.

The one case none of this catches: every check here is on exact bytes, and an iPhone
hands the picker a JPEG transcoded from the original HEIC rather than the file itself.
So a photo already here as a HEIC, or one whose transcode is not byte-for-byte
repeatable, can land a second time as a visually identical but differently encoded
file. ⚙ → *Duplicates* will not pair those either -- it too is byte-exact, on purpose,
because it offers to delete. Nothing here guesses that two photos are the same one.

### 1. R2 credentials

In the Cloudflare dashboard: **R2 -> Manage API Tokens -> Create API token**, with
**Object Read & Write** scoped to *just this bucket*. Then in the app,
**⚙ -> Portable cloud snapshot -> Set up**, fill in account ID, bucket name and both
keys, and press **Test connection**. Keys are stored in the local database, are
write-only over the API, and can only be set from the computer running the server.

### 2. Deploy the Worker

The bucket has no public URL: the Worker is the only way in.

```bash
cd worker
npx wrangler login
```

Set `bucket_name` in `wrangler.toml` if your bucket is not called `photomap`, then
generate a password hash without putting the password in your shell history:

```bash
python -c "import hashlib,getpass;print(hashlib.sha256(getpass.getpass('Viewer password: ').encode()).hexdigest())"
```

```bash
npx wrangler secret put PASSWORD_HASH
npx wrangler secret put SESSION_SECRET
npx wrangler deploy
```

`SESSION_SECRET` should be a long random string -- any password manager will make one.
Deploy prints a `https://photo-map.<you>.workers.dev` address; paste it into the
**Viewer URL** field in the app so the settings dialog can offer it as a link.

### 3. Sync

**Sync now** in settings, or automatically after each library scan (on by default).
The app also fires a best-effort sync when you leave the page -- browsers do not
guarantee that one completes, which is why sync-on-scan is the reliable trigger.

### What the protection is and is not

The Worker checks a password server-side and issues an HMAC-signed, HttpOnly session
cookie valid for 30 days. Wrong passwords are rejected with a fixed delay, and forged
or expired cookies fail signature verification. **Cloudflare Access would be the
stronger option, but it requires a custom domain and cannot protect a free
`workers.dev` or `r2.dev` address** -- if you later add a domain, put Access in front
of this too. There is no rate limiting beyond the login delay, since that needs
Durable Objects, so choose a long password. Rotate access by running
`wrangler secret put SESSION_SECRET` again, which invalidates every existing session.

## Layout

```
backend/
  main.py        FastAPI routes, access gate, filter builder, analytics queries
  auth.py        access key + unlock page for non-loopback clients
  netinfo.py     which addresses other devices can reach this server on
  nametime.py    capture times recovered from filenames
  dupes.py       content-hash duplicate detection
  r2.py          SigV4-signed S3 client for R2 (standard library only)
  snapshot.py    builds the manifest + content-addressed snapshot thumbnails
  sync.py        delta upload, prune, background thread
  db.py          SQLite schema, connections, settings, roots
  photometa.py   EXIF: GPS, capture time, camera, dimensions
  scanner.py     threaded folder walk and index upsert
  thumbs.py      on-demand thumbnail/preview cache
frontend/
  index.html     single page, no build step
  js/            ES modules: map, globe, gallery, journal, timeline, sidebar,
                 lightbox, insights, theme
  vendor/        leaflet + maplibre, served from here rather than a CDN
viewer/          uploaded to the bucket root, every file, whenever it changes
  index.html     the standalone snapshot viewer
  sw.js          service worker: offline shell + thumbnail cache
  manifest.webmanifest, icon.svg, apple-touch-icon.png   installability
worker/
  src/worker.js  Cloudflare Worker: password gate + serves the private bucket
tests/           sigv4 vs botocore, sync against a mock S3, worker auth and
                 write-back, cloud change round-trip, filename dates,
                 duplicate detection and delete safety
data/            photomap.db + thumbs/ (created on first run, safe to delete)
```

Run the tests with `.venv\Scripts\python.exe tests\test_sync.py`,
`tests\test_writeback.py`, `tests\test_nametime.py`, `tests\test_dupes.py`,
`node tests\test_worker.mjs`, and (after `pip install botocore`) `tests\test_sigv4.py`.

Rescanning is incremental: files whose size and mtime are unchanged are skipped.

A file the scan no longer sees is handled one of two ways, because the two cases mean
different things: if it is genuinely gone from disk it is flagged **missing** and drops
out of the views (the count is a warning that the index has drifted); if it still exists
but no longer sits under any configured root, it is simply removed from the index,
because it is not part of the library any more.

## API

Everything the UI uses is a plain HTTP endpoint on `127.0.0.1:8712`, so the index is
scriptable: `/api/points`, `/api/photos`, `/api/timeline`, `/api/dist`, `/api/stats`,
`/api/albums`. All of them accept the same filter query params
(`from`, `to`, `bbox`, `album`, `camera`, `gps`, `fav`, `q`), where `q` matches the
path or the note.

Notes are written with `POST /api/photos/<id>/note` and a `{"note": "..."}` body; an
empty string clears it. Journal days are `GET /api/days` and
`PUT /api/days/<YYYY-MM-DD>` with `{"text": "...", "lat": ..., "lon": ...}`; omit the
coordinates to let the day be placed by the nearest photo, and send empty text to
delete it.
