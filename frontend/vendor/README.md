# vendor/

Third-party browser libraries, served from this machine instead of a CDN.

They used to be loaded from unpkg. That meant the app - a local tool, pointed at
a local library, usable with no internet at all for everything except the
basemap - would not start if unpkg was down or blocked. Nothing here is built or
patched; these are the published files, byte for byte, at the versions the app
was written against.

| Path | Package | Version | Source |
| --- | --- | --- | --- |
| `leaflet/leaflet.{js,css}`, `leaflet/images/` | leaflet | 1.9.4 | `unpkg.com/leaflet@1.9.4/dist/` |
| `leaflet/leaflet.markercluster.js`, `leaflet/MarkerCluster.css` | leaflet.markercluster | 1.5.3 | `unpkg.com/leaflet.markercluster@1.5.3/dist/` |
| `leaflet/leaflet-heat.js` | leaflet.heat | 0.2.0 | `unpkg.com/leaflet.heat@0.2.0/dist/` |
| `maplibre-gl/maplibre-gl.{mjs,css}` + `-worker.mjs` + `-shared.mjs` | maplibre-gl | 6.3.0 | `unpkg.com/maplibre-gl@6.3.0/dist/` |

`images/` is Leaflet's own: `leaflet.css` refers to it by relative path.

All four MapLibre files have to sit in one directory and keep these names.
`maplibre-gl.mjs` and `maplibre-gl-worker.mjs` both `import "./maplibre-gl-shared.mjs"`,
and the main module locates the worker through `import.meta.url`. Being on this
origin is what lets that worker start directly, without the blob-and-import
shim MapLibre otherwise needs to get around the same-origin rule for workers.

## Upgrading

Download the files above at the new version, keeping the layout, then update the
version in this table, the pin in `js/globe.js`, and the note in the README's
Globe section. There is no build step and no lockfile: what is in this folder is
what the browser runs.

## What is still remote

Map tiles - CARTO, OpenStreetMap and Esri. Those are not vendorable: the app
would have to ship the planet. A tile outage leaves the map blank but the app
running, which is the difference between this folder and that problem.
