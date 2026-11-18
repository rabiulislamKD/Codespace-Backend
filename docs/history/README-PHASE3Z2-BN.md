# My Chat Agent v3 — Phase 3Z2 (বাংলা)

## কী ঠিক করা হয়েছে

- Multi-agent-এর Planning, Architecture/Risk এবং Test Strategist-এর বড় advisory report আর chat-এ আলাদা assistant message হিসেবে দেখানো হয় না। এগুলো সীমিত দৈর্ঘ্যের internal context হিসেবে Implementer-কে দেওয়া হয়।
- Independent QA review আর দ্বিতীয় assistant bubble তৈরি করে না। ব্যবহারকারী শুধু মূল Implementer/AI reply দেখবেন।
- Implementer-কে internal specialist notes quote/repeat না করার স্পষ্ট নির্দেশ দেওয়া হয়েছে।
- Chat history redraw/session history refresh চলাকালে Multi-agent কাজ করলে animated Thinking/Working bubble আর অকারণে hidden হয়ে যাবে না; এটি বর্তমান user message-এর নিচে পুনরায় বসবে।
- OpenCode CLI bridge, extension marketplace, task plan, themes ও PWA assets রাখা হয়েছে। PWA cache version bump করা হয়েছে যাতে নতুন app shell পুরোনো cached HTML দিয়ে আটকে না থাকে।

## আপডেট

আগের project-এর backup নিয়ে ZIP extract করুন। `my-chat-agent-v3.html`, `agent-server.js`, `pwa/` এবং verification files একই project folder-এ রাখুন। OpenCode mode ব্যবহার করলে একই OS user-এর অধীনে `opencode --version` কাজ করতে হবে।

## Checks

- `node --check agent-server.js` — PASS
- HTML inline JavaScript syntax — PASS
- `node verify.cjs` — 58/58 PASS
- `node verify-opencode-bridge.cjs` — 4/4 PASS (mock CLI)

Live provider, real OpenCode coding task, and complete multi-agent end-to-end workflow were not run during this package build.
