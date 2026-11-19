// Laedt die Preise der Bestellung.
window.ladePreise = function () {
    location.hash = 'preise-' + Date.now();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40000);
    fetch('/o/DataProxy?connector=HTTP-X-Preise', { signal: controller.signal })
        .then(() => { document.getElementById('preis').textContent = 'geladen'; })
        .catch(() => {});
};
