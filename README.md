# Polokwane projects map

An interactive map of government projects across all 45 wards of Polokwane Municipality, Limpopo. It shows each project's status, its budget per year (original vs adjusted), whether money was added or cut, and who built it. The Sebayeng/Dikgale cluster (wards 24 and 29 to 33) has the most detail: every project there was traced through budgets, IDPs and performance reports.

The map is a static site: HTML, CSS and JavaScript on the [Google Maps JavaScript API](https://developers.google.com/maps/documentation/javascript). It has no backend and no build step. You can switch between road, satellite (hybrid) and terrain views on the map.

## Set up a Google Maps API key

1. In [Google Cloud Console](https://console.cloud.google.com/), create or pick a project and enable billing. The Maps JavaScript API has a monthly free allowance that a small site like this stays inside.
2. Enable **Maps JavaScript API** for the project.
3. Under **APIs & Services > Credentials**, create an API key. Restrict it to **HTTP referrers** (for example `http://localhost:9090/*` and your live site address) and to the Maps JavaScript API only.
4. Copy the config template and add the key:

   ```bash
   cp config.example.js config.js
   ```

   Then set `apiKey` in `config.js`. `config.js` is in `.gitignore`.

5. Optional: create a map ID under **Map Management** and set `mapId`. Without one, the page uses Google's `DEMO_MAP_ID`, which is fine for testing.

Without a key, the page uses a free map instead: [Leaflet](https://leafletjs.com/) with OpenStreetMap street tiles and Esri satellite imagery. You can switch between the two on the map. It shows the same pins and filters as the Google version.

## Run it locally

You can open `index.html` directly: the data is also in `data/projects.js`, so it works from `file://`. Google Maps may refuse a `file://` page if your key has referrer restrictions, so a local server is still the most reliable way:

```bash
cd dikgale-map
python3 -m http.server 9090
```

Then open http://localhost:9090.

## Project layout

```
index.html              page structure
config.example.js       template for config.js (API key, map ID, map type)
style.css               styles (light and dark mode)
app.js                  map, filters, list and detail panel
data/projects.csv       one row per project (edit this)
data/budget_lines.csv   one row per budget year or funding source (edit this)
data/projects.json      generated data file
data/projects.js        the same data as a script, so the page works from file://
data/history.csv        what each budget or plan document said about each project, over time (optional)
data/routes.geojson     road lines for road projects, from OpenStreetMap (optional)
data/wards.geojson      boundaries of all 45 Polokwane wards (Municipal Demarcation Board, 2020/21 wards)
data/clusters.csv       Polokwane's clusters and the wards in each (cluster,wards,source)
data/wards.js           the same boundaries as a script (generated)
data/excluded.csv       projects checked and left out, with the reason (not shown on the map)
tools/build_data.py     builds projects.json from the two CSVs
```

## Add or change projects

1. Edit `data/projects.csv` and `data/budget_lines.csv` in a spreadsheet or text editor.
2. Rebuild the JSON:

   ```bash
   python3 tools/build_data.py
   ```

3. Reload the page.

The script also checks each pin against the ward boundaries and prints a warning when a pin falls outside the ward given in the `ward` column.

The script stops with a line number if a row has a problem, such as an unknown status, a non-numeric amount, or a budget line pointing at a project id that does not exist.

### projects.csv columns

| Column | Notes |
| --- | --- |
| `id` | Unique, no spaces, e.g. `road-titibe-makgoba` |
| `name` | Full project name as it appears in the budget |
| `short` | Short label shown on the map (optional) |
| `sector` | Water, Roads, Bridges, Sport, Housing, and so on |
| `status` | `complete`, `in_progress`, `funded`, `deferred` or `planned` |
| `status_note` | Free text, e.g. "64% complete, June 2024" |
| `progress` | Percentage complete, e.g. `64%`. Shows as a progress bar (optional) |
| `due` | Planned completion, e.g. `2024-07` (optional) |
| `data_issue` | Problem with the source figures. Shows a "Figures disputed" badge (optional) |
| `implementer` | Municipality, CoGHSTA, RAL, Department of Health, and so on |
| `contractor` | Company appointed to build it, as named in the source. Several: separate with `;` (optional) |
| `consultant` | Design or supervision consultant, same format (optional) |
| `contract_note` | Contract reference, award date, value with VAT basis, and source page (optional) |
| `level` | Level of government: `municipal`, `district`, `provincial` or `national` |
| `ward`, `village` | Location description |
| `lat`, `lon` | Decimal degrees. Leave both empty if unknown; the project still shows in the list |
| `pin` | How exact the pin is: `site` (the project site), `village` (village centre, site unknown; shows a halo) or `route` (the project has a line in `routes.geojson`). Empty means `site` |
| `note` | Free text |
| `sources` | `Label \| URL`, with several separated by `;` |

### budget_lines.csv columns

| Column | Notes |
| --- | --- |
| `project_id` | Must match an `id` in projects.csv |
| `fy` | Financial year, e.g. `2025/26` |
| `original` | Original budget in rands, excluding VAT |
| `adjusted` | Adjusted budget. Leave empty for planned future years |
| `label` | Funding source, e.g. `IUDG`, `CRR`, `RBIG` |

### routes.geojson

A GeoJSON FeatureCollection with one feature per road project. Each feature has a `LineString` or `MultiLineString` geometry and these properties:

| Property | Notes |
| --- | --- |
| `project_id` | Must match an `id` in projects.csv |
| `source` | Where the line comes from, e.g. OpenStreetMap way ids |
| `note` | How the road was identified and which section is drawn. Shows in the detail panel |

The map draws the line in the project's status colour. If the project has no `lat` and `lon`, the build script puts its pin on the middle of the line.

### history.csv columns

| Column | Notes |
| --- | --- |
| `project_id` | Must match an `id` in projects.csv |
| `date` | When the document was published, `YYYY-MM` |
| `document` | Short name, e.g. `Final IDP 2025/26` |
| `fy` | Financial year the amount is for |
| `amount` | Rands. Leave empty for a progress-only entry |
| `vat` | `excl`, `incl` or `not stated` |
| `progress` | Progress the document reports, e.g. `64%` |
| `note` | Funding source, page reference, and so on |

The detail panel lists these entries by date and marks with ▲ or ▼ when a year's figure went up or down from the previous document.

A project can have several lines for the same year when it has more than one funding source. The map compares the sum of original amounts against the sum of adjusted amounts to decide whether money was added or cut.

## Cache

`tools/build_data.py` stamps `?v=<hash>` on the CSS, script and data files in `index.html`. Browsers then fetch new copies after each change instead of mixing an old `app.js` with new data. Run the build script before every commit.

## Links and downloads

The address keeps the open project and the filters, so you can share a view:

| Parameter | Example |
| --- | --- |
| `p` | `?p=road-titibe-makgoba` opens one project |
| `q` | `?q=Titibe` searches |
| `status` | `?status=deferred,funded` |
| `sector`, `ward`, `level`, `money` | `?ward=32&money=cut` |
| `cluster` | `?cluster=Sebayeng/Dikgale` shows one cluster |
| `contractor` | `?contractor=Makeyise Trading and Projects` |
| `sort` | `?sort=budget`, `added`, `cut` or `recent` (default: name) |
| `shade` | `?shade=1` shades the wards by 2025/26 budget |
| `theme` | `?theme=clean`, `editorial` or `civic` |

The detail panel has a **Copy link to this project** button. **Download as CSV** saves the projects that match the current filters, with their headline figure, budget change, budget lines, link and sources.

## Where the money goes

The table above the map gives each cluster's 2025/26 budget, the money added and cut at the mid-year adjustment, and the 2026/27 plan, for the projects that match the current filters. The 2025/26 budget is the adjusted amount where the adjustments budget gives one, otherwise the original. A project in several wards is split equally between them, so cluster totals add up to the municipal total. **Shade wards by budget** colours the map the same way.

## Link preview

`og.jpg` (1200 × 630) is the image WhatsApp, Facebook and others show when the link is shared, set by the `og:` tags in `index.html`. It has no figures in it, so it does not go out of date.

## Deploy

Any static host works. Copy the folder as-is:

Put a `config.js` with your key next to `index.html` on the host, and add the host's address to the key's allowed referrers.

- **GitHub Pages:** push to a repository and enable Pages on the main branch.
- **Azure Static Web Apps or Blob Storage static website:** upload the folder contents.
- **Netlify or Cloudflare Pages:** drag the folder into the dashboard.

## Data notes

- Amounts come from Polokwane Municipality budget documents and are in rands, excluding VAT.
- Some pins mark the village rather than the exact site. The project's `note` says when this applies.
- Google Maps usage is billed per map load above the free allowance. Restrict the API key to your site's address so other sites cannot use it.
