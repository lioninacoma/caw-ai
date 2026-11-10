// Eine Web Component mit offenem Shadow Root, wie Lit, Stencil oder Shoelace sie erzeugen: Feld, Knopf und Statusmeldung nur im Shadow DOM.
class Bewertung extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return
    const root = this.attachShadow({ mode: 'open' })
    root.innerHTML = '<div role="group" aria-label="Bewertung"><label>Kommentar <input></label> <button type="button">Bewerten</button><p role="status"></p></div>'
    root.querySelector('button')!.addEventListener('click', () => {
      root.querySelector('[role=status]')!.textContent = `Danke für „${root.querySelector('input')!.value}“`
    })
  }
}
if (!customElements.get('caw-bewertung')) customElements.define('caw-bewertung', Bewertung)
