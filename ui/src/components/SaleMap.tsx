type SaleMapProps = {
  lat: number;
  lon: number;
  label: string;
};

export function SaleMap({ lat, lon, label }: SaleMapProps) {
  const delta = 0.012;
  const bbox = [lon - delta, lat - delta, lon + delta, lat + delta].join(",");
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${lat}%2C${lon}`;

  return (
    <div className="overflow-hidden rounded-xl bg-white shadow-sm">
      <iframe
        title={`Map for ${label}`}
        src={src}
        className="h-56 w-full border-0"
        loading="lazy"
      />
    </div>
  );
}
