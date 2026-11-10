const BUILD = process.env.NEXT_PUBLIC_BUILD ?? "dev";

export default function InfoPage() {
  return <section aria-label="Info"><h1>Info</h1><p>Diese Seite wird nachgeladen.</p><p data-testid="build-info">Build: {BUILD}</p></section>;
}
