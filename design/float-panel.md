# Floating panel (copy and paste guide)

A small, non-modal card for "the thing I just selected". It floats over the page, so it is in view however far down the list the click was.
Wide screens: docked on the left. Phones (900px and narrower): a bottom sheet. No dependencies, nothing album-specific.
First used in Music Collection (`app.html`, search for `floatPanel`).

## 1. HTML hook

Nothing to add to the page. `floatPanel` builds its own element and appends it to `<body>`:

```html
<div class="fpanel" role="dialog" aria-modal="false" aria-labelledby="fpanel-title">
  <div class="fpanel-grab" aria-hidden="true"></div>
  <button class="fpanel-x" type="button" aria-label="Close details">×</button>
  <div class="fpanel-body"><!-- your html --></div>
</div>
```

In the html you pass, mark the heading with `data-fp-title`. It becomes the dialog's label and the element that gets focus
(`id`, `tabindex="-1"` are added for you). Without one, `label` is used as `aria-label`.

## 2. CSS

Uses only your colour tokens: `--raise`, `--fg`, `--line`, `--surface`, `--shadow`. Rename them to your own. Nothing else is app-specific.

```css
:root{--fp-w:320px;--fp-gap:16px;--fp-top:96px}   /* top: below your sticky header, if you have one */
.fpanel{position:fixed;z-index:100;left:16px;top:var(--fp-top);width:var(--fp-w);max-height:calc(100vh - var(--fp-top) - 16px);display:flex;flex-direction:column;background:var(--raise);color:var(--fg);border:1px solid var(--line);border-radius:16px;box-shadow:0 28px 56px -12px var(--shadow),0 6px 18px var(--shadow);animation:fpin .18s ease-out}
.fpanel-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:16px}
.fpanel-x{position:absolute;top:8px;right:8px;z-index:2;width:40px;height:40px;padding:0;display:grid;place-items:center;border-radius:50%;border:1px solid var(--line);background:var(--surface);color:var(--fg);font-size:22px;line-height:1;cursor:pointer}
.fpanel-x:hover{border-color:var(--fg)}
.fpanel-grab{display:none;flex:none;width:40px;height:5px;border-radius:3px;background:var(--line);margin:8px auto 0}
.fpanel [data-fp-title]:focus{outline:none}
@keyframes fpin{from{opacity:0;transform:translateX(-24px)}to{opacity:1;transform:none}}
@keyframes fpup{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}
@media (max-width:900px){
  .fpanel{left:8px;right:8px;top:auto;bottom:0;width:auto;max-height:70vh;border-radius:16px 16px 0 0;border-bottom:0;animation-name:fpup}
  .fpanel-grab{display:block}
  .fpanel-body{padding:10px 14px calc(14px + env(safe-area-inset-bottom,0px))}
}
@media (prefers-reduced-motion:reduce){.fpanel{animation:none}}
```

Page glue (yours, not part of the component): while the panel is open `<body>` has class `fp-open`. On wide screens push the page content over so
nothing hides under the panel. `.wrap` is the page's centred column (max 1180px); the sum only pads as far as needed, so a very wide screen gets no extra:

```css
@media (min-width:901px){body.fp-open .wrap{padding-left:max(16px,calc(var(--fp-w) + var(--fp-gap) * 2 - max(0px,(100vw - 1180px) / 2)))}}
```

Stacking: panel `z-index:100`. Keep your menus, toasts and anything else that must sit on top above that (Music Collection: menu 200, toasts 300).
Native `<dialog>.showModal()` always sits above it.

## 3. JS API

Copy the `floatPanel` block from `app.html` (about 40 lines).

```js
floatPanel.open(html, { label, returnTo, onClose })  // show it, or swap the content if already open; focus goes to the [data-fp-title] heading
floatPanel.update(html)                              // re-render in place (keeps scroll position and the focused control's place if you restore it)
floatPanel.close()                                   // hide, call onClose, put focus back on returnTo
floatPanel.close({ silent: true })                   // hide without onClose (use when your own state already changed); focus only returns if it was inside the panel
floatPanel.isOpen()
```

- `label`: accessible name when the html has no `data-fp-title`.
- `returnTo`: an element, or a function that returns one (use a function when your list re-renders and the old element goes stale). Used only if it is still in the page.
- `onClose`: clear your own selection state here. It runs for the × button, Escape and `close()`, not for `close({ silent: true })`.
- `update` with identical html does nothing, so you can call it after every render of your list.

Typical wiring (state is yours; the panel only shows it):

```js
function syncPanel() {                       // call at the end of every render
  if (!selected || !stillExists(selected) || !ownerPageIsShowing()) { selected = null; floatPanel.close({ silent: true }); return; }
  const html = detailHtml(selected);
  if (floatPanel.isOpen() && sameThing) floatPanel.update(html);
  else floatPanel.open(html, { label: selected.title, returnTo: () => findRow(selected), onClose: () => { selected = null; render(); } });
}
```

Your own buttons inside the html keep working through the page's normal (delegated) click handler, because the panel is ordinary DOM in `<body>`.

## 4. Behaviour

| | Wide (over 900px) | Phone (900px and narrower) |
|---|---|---|
| Shape | card, left 16px, top 96px, 320px wide, scrolls inside, max height to 16px above the bottom | bottom sheet, 8px side margins, up to 70vh, scrolls inside, rounded top, grab bar |
| Page | stays scrollable and clickable; content padded left (see glue) so nothing sits under it | overlays the page, no padding change |
| Entrance | slide from the left + fade, 180ms | slide up + fade, 180ms |
| Close | ×, Escape (focus inside), selecting the same thing again (your code), tab change (your code) | same |

Reduced motion: no animation.

## 5. Accessibility

- `role="dialog"` with `aria-modal="false"` (it does not trap focus or block the page) and `aria-labelledby` the heading.
- Opening moves focus to the heading with `focus({ preventScroll: true })`, so the page does not jump.
- Closing returns focus to `returnTo` (the thing that opened it) when it is still in the page.
- Escape closes it when focus is inside. Add your own Escape handler for the list items if you want Escape to work from there too.
- Tap targets in the sheet should be 40px or taller (the × is 40px).
- Menus, dialogs and toasts you open from inside it must sit above it (see Stacking), and they return focus to the control that opened them.
