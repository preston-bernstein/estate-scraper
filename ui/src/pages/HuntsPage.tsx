import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import type { Hunt } from "../types";

export function HuntsPage() {
  const [hunts, setHunts] = useState<Hunt[]>([]);
  const [radiusMiles, setRadiusMiles] = useState(30);
  const [name, setName] = useState("");
  const [keywords, setKeywords] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [huntsResult, settings] = await Promise.all([
        api.getHunts(),
        api.getSettings(),
      ]);
      setHunts(huntsResult.hunts);
      setRadiusMiles(settings.radiusMiles);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load hunts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();

    const keywordList = keywords
      .split(",")
      .map((keyword) => keyword.trim())
      .filter(Boolean);

    if (!name.trim() || keywordList.length === 0) {
      return;
    }

    const result = await api.createHunt(name.trim(), keywordList);
    setHunts((current) => [...current, result.hunt]);
    setName("");
    setKeywords("");
  }

  async function handleDelete(id: number) {
    await api.deleteHunt(id);
    setHunts((current) => current.filter((hunt) => hunt.id !== id));
  }

  function handleRadiusChange(value: number) {
    setRadiusMiles(value);
  }

  async function handleRadiusCommit(value: number) {
    await api.updateSettings(value);
  }

  if (loading) {
    return <p className="text-sm text-gray-500">Loading hunts…</p>;
  }

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Hunts</h1>
        <p className="mt-1 text-sm text-gray-600">
          Saved keyword filters applied when browsing Findings.
        </p>
      </div>

      <section className="rounded-xl bg-white p-4 shadow-sm">
        <label className="block text-sm font-medium text-gray-700">
          Radius: {radiusMiles} miles
        </label>
        <input
          type="range"
          min={5}
          max={60}
          step={5}
          value={radiusMiles}
          onChange={(event) => handleRadiusChange(Number(event.target.value))}
          onPointerUp={(event) =>
            void handleRadiusCommit(Number((event.target as HTMLInputElement).value))
          }
          className="mt-3 w-full accent-[#007AFF]"
        />
      </section>

      <form
        onSubmit={(event) => void handleCreate(event)}
        className="space-y-3 rounded-xl bg-white p-4 shadow-sm"
      >
        <h2 className="font-medium">New hunt</h2>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Hunt name (e.g. furniture)"
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
        />
        <input
          value={keywords}
          onChange={(event) => setKeywords(event.target.value)}
          placeholder="Keywords, comma-separated"
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="rounded-full bg-[#007AFF] px-4 py-2 text-sm font-medium text-white"
        >
          Create hunt
        </button>
      </form>

      <section className="space-y-3">
        {hunts.map((hunt) => (
          <article
            key={hunt.id}
            className="flex items-start justify-between rounded-xl bg-white p-4 shadow-sm"
          >
            <div>
              <h3 className="font-medium">{hunt.name}</h3>
              <p className="mt-1 text-sm text-gray-600">
                {hunt.keywords.join(", ")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleDelete(hunt.id)}
              className="text-sm text-gray-500 hover:text-red-600"
            >
              Delete
            </button>
          </article>
        ))}
      </section>
    </div>
  );
}
