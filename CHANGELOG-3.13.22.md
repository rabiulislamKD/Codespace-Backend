# CodeSpace 3.13.22 — Copilot only when selected, clean provider UI

## CodeSpace Copilot
- **Copilot never starts on its own.** Automatic model switching now runs only while **CodeSpace Copilot** is selected in the model menu. A model you pick by hand (free or paid) is always called as itself: normal retry, no switch to another model, no "CodeSpace Copilot" status or notes. Before, any hand-picked `:free` model was silently put into the Copilot pool.
- Choosing a provider by any other route (Models panel card, adding or deleting a provider, Chat Z.ai toggle) also turns Copilot off, so the status bar always matches what is really used.
- **Free only.** Even with Copilot selected, only free models are tried (`:free` IDs and Chat Z.ai). A paid model is never added as a fallback and a paid active model is never swapped.

## Cleaner UI
- Models panel: each provider is one small card with its name, **Edit** and **Delete**. Details (type, model, address, context, price) show only when the pointer is on the **?** icon.
- Add/Edit provider: shorter labels and placeholders; descriptions moved into **?** tooltips (type, chat path, key header, extra headers/fields, context, prices, caching, image input, thinking). The provider gallery shows name + tag; the blurb is in a **?**.
- Settings and Code search: long checkbox and field descriptions moved into **?** tooltips.
