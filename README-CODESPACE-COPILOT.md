# CodeSpace Copilot — automatic model switching

Pick **CodeSpace Copilot** (top of the model menu). It is the only thing that turns automatic switching on: a model you choose by hand is never swapped. When the active model fails, CodeSpace switches to the next available model immediately. There is no cooldown and no time limit.

- Pool: every free model of every configured provider (`:free` IDs), plus Chat Z.ai models while Chat Z.ai is ON. Models on this computer (Ollama, LM Studio) are not part of the pool.
- Switches on: rate limits, quota, overload, unavailable model, network errors, in-stream gateway errors ("Provider returned error"), an empty reply, a model that does not answer for 60 s, a rejected request (400/422) and a bad key on one provider.
- Each model is tried at most once per request. The status line and a chat note show which model is active.
- If every model fails, one clear error lists what was tried; if all of them rejected the key, the key problem is reported. The next message tries again right away.
- With only one model available, normal retry with backoff is used.
- Paid models are never tried as a fallback and a paid model is never swapped for another.
- Selecting any model or provider by hand turns Copilot off until you select it again.
- Pressing Stop never triggers a switch.

## Model menu

Models are shown in two groups: **Free models** (ID ends in `:free`, and Chat Z.ai models) and **Paid models** (everything else — a label, not a billing guarantee). The Chat Z.ai provider is listed only while Chat Z.ai is ON.
