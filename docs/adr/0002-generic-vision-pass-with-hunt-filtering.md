# Generic vision pass with per-Hunt client-side filtering

Different users hunt for different items, and interests change week to week. Running a per-person or per-interest vision pass would require re-running Ollama (expensive, slow) every time interests shift. Instead, the vision pass runs once with a broad prompt capturing everything potentially valuable; Hunts are saved keyword filters applied at browse time for free. The trade-off is a slightly less precise vision prompt, accepted because re-run cost is prohibitive.
