# My Chat Agent v3 — Phase 3Z1 (Windows OpenCode CLI fix)

এই hotfix-টি তোমার Phase 3Z-এর OpenCode bridge-এর Windows launch problem ঠিক করে। Error-এ `opencode.exe`-এর `MZ` header-কে JavaScript হিসেবে parse করার চেষ্টা হচ্ছিল। কারণ npm-এর Windows shim থেকে পাওয়া native executable-টি ভুল করে `node.exe` দিয়ে চালানো হচ্ছিল।

## Update করার নিয়ম

1. My Chat Agent-এর server বন্ধ করো (`Ctrl+C`)।
2. এই ZIP Extract করো এবং বর্তমান ফোল্ডারের backup রাখো।
3. নতুন `agent-server.js` ও `my-chat-agent-v3.html`-সহ package-এর files ব্যবহার করো। `data/`, project, settings, session বা user-created files থাকলে সেগুলো overwrite করো না; এই package-এ সেগুলো থাকার কথা নয়।
4. আগের একই PowerShell/Windows user account থেকে server আবার চালাও।
5. Browser-এ My Chat Agent খুলে Settings/Bridge Connect নিশ্চিত করো। OpenCode toggle বন্ধ করে আবার চালু করো।

## পরীক্ষা

আগে তোমার Windows terminal-এ `opencode --version` কাজ করেছে (`1.19.5`)। Hotfix-এর পর bridge আর `.exe`-টিকে Node.js script হিসেবে চালানোর চেষ্টা করবে না।

প্রথমে পরীক্ষা:

```powershell
opencode --version
node --check .\agent-server.js
node .\agent-server.js
```

তারপর My Chat Agent-এ OpenCode toggle চালু করো। সফল হলে safe prompt পাঠাও:

```text
Reply only OK. Do not modify any files.
```

## গুরুত্বপূর্ণ

- এই fix Free-tier restriction bypass করে না; OpenCode-এর নিজস্ব login/model policy বহাল থাকবে।
- `Auto-approve` বন্ধ রাখো, যতক্ষণ না permission behavior যাচাই করেছ।
- এই build-এর Linux container-এ mock CLI tests চালানো যায়; তোমার Windows machine-এ live bridge test করার পরেই native Windows launch end-to-end নিশ্চিত হবে।


## Phase 3Z2 — Clean Multi-agent Chat & Thinking Bubble

- Planning, architecture, and test-strategy outputs are now kept as bounded internal context for the implementer instead of being appended as a large assistant chat message.
- The independent QA review remains internal and no longer creates a second, non-user-facing assistant bubble after the actual answer.
- The implementer is explicitly instructed not to quote internal specialist findings; users should see the actual assistant reply only.
- The animated Multi-agent activity bubble is preserved and reattached under the current user message if chat history is redrawn while a turn is active.
- OpenCode mode continues to show its own final answer; it does not display Multi-agent preflight/review descriptions.

Checks: source/feature regression checks and mock OpenCode bridge tests; no live provider or full live Multi-agent task was run as part of this package build.
