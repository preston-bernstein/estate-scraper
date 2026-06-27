# Estate Sale Scanner

A scheduled tool that scrapes estate sale listings within a geographic radius, runs local vision analysis on listing images, and presents findings through a browsable dashboard filtered by personal interest profiles.

## Language

**Sale**:
A single estate sale listing on estatesales.net with a defined date range, physical address, and set of listing images.
_Avoid_: listing, event, result

**Finding**:
A single image from a Sale that the vision model flagged as containing potentially valuable items, together with the model's plain-text description of what it saw.
_Avoid_: result, match, hit, detection

**Hunt**:
A named, saved keyword filter belonging to a person, used to narrow the full set of Findings to items of current interest. A person may have multiple Hunts active at once, and interests change week to week.
_Avoid_: filter, search, profile, watchlist

**Scan**:
A full scheduled run that scrapes all Sales within the configured radius and runs vision analysis on every listing image. Runs once per week (Friday 1am). Results accumulate — a Scan never overwrites prior data.
_Avoid_: job, run, crawl, refresh

**Radius**:
The geographic search boundary for a Scan, centered on the configured home address and expressed in miles. Determines which cities are included.
_Avoid_: area, region, distance

**Home**:
The fixed reference address used to calculate distance to each Sale and to define the Radius. Currently YOUR_HOME_ADDRESS, Decatur GA YOUR_HOME_ZIP.
_Avoid_: location, origin, base

**Plan**:
The user's ordered set of Sales they have decided to attend on a given day, draggable to reflect intended visit sequence. A Sale in the Plan has been explicitly chosen from Hunt results; a dropped Sale is excluded but not permanently hidden.
_Avoid_: route, itinerary, shortlist, queue

**Standout**:
A Finding whose `scoreFinding()` score is ≥ 4, eligible for display in the horizontal featured-item scroll on the Discover page. Standouts surface the single best individual items across all Sales, not the best Sales overall.
_Avoid_: featured, highlight, top pick, hero
