# CodeSpace 3.8.2 — Embedded Browser Fix (বাংলা)

এই সংস্করণে Desktop Browser-এর সব website navigation ও AI browser tool একই embedded Chromium `<webview>`-এ চালানো হয়েছে। Desktop build-এ Agent Chrome/বাইরের Chrome mode সরানো হয়েছে এবং backend-এ external Chrome launcher নিষ্ক্রিয় করা হয়েছে।

## Build
1. ZIP extract করো।
2. Windows build PC-তে Node.js 22+ ইনস্টল থাকতে হবে।
3. `BUILD-PORTABLE-EXE.bat` চালাও।
4. EXE তৈরি হবে `release` folder-এ: `CodeSpace-Portable-3.8.2.exe`।
5. আগে পুরোনো CodeSpace বন্ধ করো। নতুন EXE চালাও।

## গুরুত্বপূর্ণ
- Browser panel-এর address bar, agent-এর browser tools, navigation, reload এবং viewport—সব embedded browser ব্যবহার করবে।
- Windows-এর default browser-এ website forward করা হবে না। External-link icon URL copy করবে।
- Browser profile/cookies-এর partition `persist:codespace-browser`; আগের profile data একই CodeSpace user-data folder-এ থাকবে।
- Cloudflare challenge বা CAPTCHA bypass করা হয় না। Challenge এলে embedded panel-এ নিজে complete করতে হবে। Electron Chromium কিছু website-এ Cloudflare block পেতেই পারে; embedded করার অর্থ Cloudflare acceptance নিশ্চিত হওয়া নয়।

## Validation সীমাবদ্ধতা
Source syntax ও automated static checks পাস করেছে। এই পরিবেশে Windows Electron EXE build বা বাস্তব Cloudflare website test চালানো হয়নি। তাই Windows-এ build করে test করতে হবে।
