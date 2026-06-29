# Estate Sale Scanner

A scheduled tool that scrapes estate sale listings within a geographic radius, runs local vision analysis on listing images, and presents findings through a browsable dashboard filtered by personal interest profiles.

## Language

**Sale**:
A single estate sale listing on estatesales.net with a defined date range, physical address, and set of listing images.
_Avoid_: listing, event, result

**Finding**:
A single image from a Sale that the vision model flagged as containing potentially valuable items, together with the model's plain-text description of what it saw.
_Avoid_: result, match, hit, detection

**Image**:
A single analyzed listing photo from a Sale — every photo the vision pipeline looked at, whether or not it was flagged. Carries the irreplaceable, durable facts that outlive the expired source listing: the CLIP/SigLIP embedding and the downscaled thumbnail. The full set of Images is the training substrate for the taste ranker; the flagged subset becomes Findings. A "waste" Outcome stamps confirmed-negative on all of a Sale's Images.
_Avoid_: photo, picture, thumbnail (as the record name), asset

**Item**:
A single identified object within a Finding. One Finding (image) may contain many Items. An Item carries the normalized, queryable identification — maker, category, era, desirability — plus the provenance of how it was identified (vlm, lexicon, or human). Items are the unit that browse-history and any future valuation query and join against; the Finding is the unit the taste ranker trains on.
_Avoid_: object, thing, lot, product, detection

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
The fixed reference address used to calculate distance to each Sale and to define the Radius. Set via HOME_* env vars (see api/.env.example).
_Avoid_: location, origin, base

**Plan**:
The user's ordered set of Sales they have decided to attend on a given day, draggable to reflect intended visit sequence. A Sale in the Plan has been explicitly chosen from Hunt results; a dropped Sale is excluded but not permanently hidden.
_Avoid_: route, itinerary, shortlist, queue

**Standout**:
A Finding whose `scoreFinding()` score is ≥ 4, eligible for display in the horizontal featured-item scroll on the Discover page. Standouts surface the single best individual items across all Sales, not the best Sales overall.
_Avoid_: featured, highlight, top pick, hero

**Desirability**:
How much a collector is likely to want an identified item, expressed as high / medium / low. Distinct from identification (what the item *is*) and from price (what it would *sell* for). Sourced from the vision model's own judgment, a curated maker lexicon, and the user's logged Outcomes — never from external market data in the current scope.
_Avoid_: value, worth, price, quality

**Reference Pass**:
A single money-no-object Scan that sends every image through the strong vision model with no budgeting, frozen and reused as the ground-truth oracle against which the cheap cascade tiers are tuned offline. Not a recurring Scan; run rarely, by intent.
_Avoid_: baseline, full scan, gold run

**Identifier**:
The product's chosen scope — it tells the user which Sales are worth attending by recognizing and describing desirable items, leaving on-site appraisal to the user. Contrasted with a Deal-Finder, which would attach market prices to items and flag underpriced ones; that requires external comps data and is out of current scope.
_Avoid_: appraiser, valuer, deal-finder (when describing current scope)

**Outcome**:
The user's own verdict on a Sale after attending it — good, meh, or waste. Authored by a human, never derived, so it cannot be regenerated and is the irreplaceable signal the system learns the user's taste from.
_Avoid_: result, rating, feedback, review
