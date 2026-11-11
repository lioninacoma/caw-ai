// A web component with an open shadow root, as Lit, Stencil or Shoelace create them: field, button and status message only in the shadow DOM.
class Rating extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return
    const root = this.attachShadow({ mode: 'open' })
    root.innerHTML = '<div role="group" aria-label="Rating"><label>Comment <input></label> <button type="button">Rate</button><p role="status"></p></div>'
    root.querySelector('button')!.addEventListener('click', () => {
      root.querySelector('[role=status]')!.textContent = `Thanks for your rating: ${root.querySelector('input')!.value}`
    })
  }
}
if (!customElements.get('caw-rating')) customElements.define('caw-rating', Rating)
