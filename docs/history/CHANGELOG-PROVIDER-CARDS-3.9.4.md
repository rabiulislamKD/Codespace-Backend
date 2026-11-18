# 3.9.4

- Add provider now opens with a gallery of 19 provider cards (search + Free / Local / Paid filters): Google Gemini, OpenAI, Claude, Cline, OpenRouter, Groq, Cerebras, Mistral, GitHub Models, NVIDIA NIM, SambaNova, Hugging Face, OpenCode Zen, Z.ai, Together, DeepSeek, Ollama, LM Studio, llama.cpp.
- Clicking a card fills the form. Hosted cards show "Get API key" (Gemini: "Sign in with Google to get a key") and "Copy link". Web: opens a new tab. Desktop: opens the built-in Browser panel (external links stay blocked) and keeps the half-filled form for the next "Add provider".
- After saving, all of the provider's models are listed in the chat model selector (3.9.2).
- Provider relay: if a hosted API refuses direct browser calls (CORS) and the bridge is connected, the request is retried through `/llm/proxy` on the bridge (https only, GET/POST, no cookies, streaming, not logged). The host is remembered for the session.
- Cline, OpenCode Zen and Z.ai addresses are marked "not tested" in the UI; use "Fetch models" to confirm.
- Tests: verify-providers.cjs (25), verify-server-hardening.cjs now 27.
