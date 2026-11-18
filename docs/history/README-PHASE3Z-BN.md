# My Chat Agent v3 — Phase 3Z
## OpenCode CLI Chat Bridge + Smart Task Plan Visibility

এই সংস্করণে দুটি পরিবর্তন আছে:

1. **Chat থেকে OpenCode CLI ব্যবহার:** Chat composer-এর `OpenCode` toggle চালু করলে prompt My Chat Agent-এর provider API-তে না গিয়ে স্থানীয় Agent Server থেকে OpenCode-এর নিজস্ব `opencode run` CLI-তে যায়। OpenCode নিজের login, provider/model, configuration ও agent ব্যবহার করে। ফলাফল progress event-সহ chat-এ ফেরত আসে এবং session ID প্রতি My Chat Agent conversation-এ সংরক্ষিত হয়।
2. **Task Plan শুধু প্রয়োজন হলে দেখা যায়:** নতুন user message শুরু হলে আগের task-এর checklist পরিষ্কার হয়। Single-agent `update_plan` বা Multi-agent planner নতুন plan তৈরি করলে checklist দেখায়। সব step `Completed` হলে checklist ও header-এর `Plan` button স্বয়ংক্রিয়ভাবে লুকায়। Pending, In progress বা Blocked step থাকলে panel থাকে, minimize/expand করা যায়। OpenCode CLI mode আগের My Chat Agent checklist মুছে দেয়, কারণ OpenCode-এর নিজস্ব plan My Chat Agent plan হিসেবে ভুলভাবে দেখানো হয় না।

## OpenCode chat চালু করা

1. **যে কম্পিউটার/পরিবেশে `agent-server.js` চলছে, সেই একই OS user account-এ OpenCode CLI ইনস্টল করুন।** My Chat Agent-এর backend Windows-এ চললে শুধুমাত্র AndroidIDE/Termux-এ ইনস্টল করা `opencode` সেখানে স্বয়ংক্রিয়ভাবে পাওয়া যাবে না।
2. Terminal-এ `opencode --version` চালিয়ে নিশ্চিত করুন CLI পাওয়া যাচ্ছে। প্রয়োজন হলে `opencode auth login` চালিয়ে OpenCode-এর সমর্থিত login/provider configuration সম্পন্ন করুন। Free model ব্যবহারযোগ্য কি না OpenCode account, installed CLI version এবং service policy-র ওপর নির্ভর করে; এই integration কোনো API restriction bypass করে না।
3. `agent-server.js` চালু করুন, My Chat Agent Settings-এ Bridge URL/token সংযোগ করুন এবং একটি workspace folder খুলুন।
4. Composer-এর **OpenCode** toggle চাপুন। App `/opencode/status` দিয়ে CLI খুঁজে দেখে।
5. Chat-এ coding task পাঠান। My Chat Agent `opencode run --format json --dir <workspace> ...` চালায় এবং ফলাফল/প্রগতি chat-এ ফেরায়। একই My Chat Agent chat-এ পরের prompt পাঠালে OpenCode session চালিয়ে নেয়।
6. আবার OpenCode toggle চাপলে My Chat Agent-এর নির্বাচিত provider/Agent/Multi-agent mode-এ ফিরে আসবেন।

### OPENCODE_BIN

CLI যদি PATH-এ না থাকে, Agent Server চালুর আগে `OPENCODE_BIN` environment variable-এ OpenCode executable/shim-এর path সেট করুন এবং server restart করুন। Windows-এ যে `agent-server.js` process চালু করছে সেটির environment-এ variable-টি থাকতে হবে।

### Permission ও নিরাপত্তা

- `Auto-approve OpenCode actions (--auto)` ডিফল্টে **বন্ধ**। এটি চালু করলে OpenCode normal permission prompt এড়িয়ে workspace file পরিবর্তন ও command চালাতে পারে; toggle enable করার সময় confirmation থাকবে।
- OpenCode bridge local-only Agent Server ব্যবহার করে এবং bridge token বাধ্যতামূলক। Token গোপন রাখুন: token-ধারী ব্যক্তি এই কম্পিউটারে command চালানোর ক্ষমতা পেতে পারেন।
- Prompt shell command হিসেবে interpolate করা হয় না; CLI process `shell:false` দিয়ে argument array-তে চালানো হয়।
- ছবি OpenCode CLI mode-এ পাঠানো হয় না। Image attachment থাকলে app সতর্ক করে, যাতে ছবি নীরবে বাদ না পড়ে। Text/file attachment-এর পাঠযোগ্য content prompt-এর সঙ্গে পাঠানো যায়।
- OpenCode provider auth/key My Chat Agent settings-এ কপি করা হয় না; OpenCode-এর নিজস্ব config ও credentials ব্যবহার হয়।

## Task Plan আচরণ

- সাধারণ ছোট প্রশ্নে model plan না তৈরি করলে checklist দেখাবে না।
- Multi-step/বহু ফাইল/risky/architectural কাজের জন্য Agent `update_plan` ব্যবহার করলে checklist দেখায়।
- Plan-এর row-তে Pending, In progress, Completed ও Blocked status থাকে।
- সব step completed হলে plan UI লুকায়; session-এ plan data থাকলেও permanent UI হিসেবে দেখায় না।
- পরের user turn-এর checklist আগের turn-এর অসম্পূর্ণ checklist থেকে আলাদা থাকে। নতুন turn-এ নতুন plan তৈরি না হওয়া পর্যন্ত আগের plan দেখায় না।

## ফাইল

- `my-chat-agent-v3.html` — UI, OpenCode toggle এবং plan visibility lifecycle
- `agent-server.js` — authenticated local bridge, OpenCode CLI discovery/execution, JSON-event stream
- `pwa/` — manifest, service worker ও icons
- `verify.cjs` — source/feature regression checks
- `verify-opencode-bridge.cjs` — mock CLI দিয়ে reproducible endpoint integration smoke test

## যাচাই

- `node --check agent-server.js` — PASS
- HTML inline JavaScript syntax (`node --check` দিয়ে) — PASS
- `node verify.cjs` — 54/54 PASS
- `node verify-opencode-bridge.cjs` — 4/4 PASS: mock CLI status, streamed answer/session ID, invalid prompt rejection, token auth

Mock CLI test বাস্তব OpenCode provider/login ব্যবহার করে না। এই পরিবেশে Chromium browser navigation-এর smoke test administrator policy দ্বারা block হয়েছে; তাই updated UI-তে visual browser test সফল হয়েছে বলে দাবি করা হচ্ছে না। বাস্তব OpenCode CLI ও free model-এর live end-to-end run-ও এখানে করা হয়নি।

## Official references

- OpenCode CLI run command: https://docs.opencode.ai/docs/cli/
- CLI command reference (`--format json`, `--session`, `--dir`, `--auto`): https://opencode.ai/v2/docs/cli/commands/

## Phase 3Z1 Windows CLI hotfix
This full package includes the Phase 3Z1 OpenCode Windows CLI resolver fix. It also preserves the original `pwa/` directory (manifest, service worker, and icons), `verify.cjs`, and `verify-opencode-bridge.cjs`. Run the server from this extracted folder so its adjacent PWA assets remain available.
