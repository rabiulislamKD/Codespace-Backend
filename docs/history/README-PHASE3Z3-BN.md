# My Chat Agent v3 — Phase 3Z3 (বাংলা)

## কী পরিবর্তন হয়েছে

### 1. সব Agent mode-এ live working animation
- সাধারণ My Chat Agent/Single Agent mode-এ মেসেজ পাঠানোর সঙ্গে সঙ্গে animated circular indicator দেখা যায়।
- Multi-agent mode-এর Planning, Architecture/Risk, Test Strategist, Implementer এবং QA activity আগের মতো একই live bubble-এ দেখায়।
- OpenCode CLI mode-ও একই indicator ব্যবহার করে; bridge-এর progress event এলে bubble-এর status text আপডেট হয়।
- বৃত্তের নিচে অস্থায়ী status text থাকে—যেমন “Thinking about your request”, “Reviewing results”, বা tool-এর নাম। এগুলো নিরাপদ progress label; model-এর private chain-of-thought প্রকাশ করে না।
- কাজ শেষ, ব্যর্থ বা বাতিল হলে indicator terminal state দেখায়, তারপর fade হয়ে স্বয়ংক্রিয়ভাবে মিলিয়ে যায়। নতুন message শুরু হলে নতুন indicator দেখা যায়।
- Responsive layout-এ ছোট পর্দাতেও status/detail text লুকিয়ে দেওয়া হয় না।

### 2. Task Plan সম্পন্ন হলে স্থায়ীভাবে লুকানো
- সব plan step `completed` হলে Task Plan সঙ্গে সঙ্গে লুকিয়ে যায়।
- বর্তমান user turn-এর জন্য completion lock সেট হয়; late `update_plan` call দিয়ে শেষ হওয়া plan আবার দেখানো যায় না।
- পরের user message-এ নতুন task turn শুরু হলে lock reset হয়—নতুন কাজের প্রয়োজন হলে নতুন plan তৈরি হতে পারে।
- Partial/blocked plan সম্পূর্ণ না হলে সেটি নিজে থেকে complete হিসেবে ধরা হয় না।

### 3. অন্যান্য আচরণ অপরিবর্তিত
- OpenCode bridge, existing permissions, extension marketplace, chat/history, themes এবং PWA files রাখা হয়েছে।
- PWA service-worker cache version bump করা হয়েছে, যাতে পুরনো HTML cache থেকে আগের activity UI না আসে।

## ইনস্টল
আগের প্রজেক্টের backup নিয়ে এই ZIP-এর সব ফাইল একসঙ্গে extract করুন। `my-chat-agent-v3.html`, `agent-server.js`, `pwa/`, `verify.cjs` এবং `verify-opencode-bridge.cjs` একই project folder-এ রাখুন। OpenCode mode চালাতে OpenCode CLI একই Windows user-এর PATH/configuration-এ থাকতে হবে এবং `opencode --version` কাজ করতে হবে।

## চালানো ও পরীক্ষা
```powershell
node --check agent-server.js
node verify.cjs
node verify-opencode-bridge.cjs
```

এই build-এ source syntax check, 62টি source-level regression check এবং mock OpenCode bridge-এর 4টি integration check চালানো হয়েছে। Live provider দিয়ে browser end-to-end test চালানো হয়নি।
