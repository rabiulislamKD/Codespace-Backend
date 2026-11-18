# CodeSpace — Portable Windows EXE (বাংলা গাইড)

এই package থেকে Windows x64-এর জন্য **CodeSpace-Portable-3.12.9.exe** তৈরি হবে। App-এর মধ্যে Electron desktop window, CodeSpace UI, local `agent-server.js` backend, প্রয়োজনীয় Node runtime এবং production dependencies প্যাকেজ হয়। ব্যবহার করতে আলাদা করে `node agent-server.js` চালাতে হবে না।

## Build

1. পুরো ZIP extract করুন, যেমন `F:\CodeSpacePortable\`।
2. Build PC-তে Node.js 22 বা newer এবং npm থাকতে হবে; target PC-তে Node install প্রয়োজন হবে না।
3. `BUILD-PORTABLE-EXE.bat`-এ double-click করুন। Script dependencies install করবে, official Node.js runtime download করে SHA-256 verify করবে এবং Electron Builder দিয়ে EXE তৈরি করবে।
4. সফল হলে `release\CodeSpace-Portable-3.12.9.exe` তৈরি হবে। এটিকে USB-তে কপি করুন এবং EXE double-click করুন।

## Browser & Cloudflare

- Browser-এর default mode **Agent Chrome**; Live page (iframe) optional। এটি CSP/X-Frame-Options-জনিত iframe block কমাতে সাহায্য করে।
- Visible Chrome/Edge ও persistent profile ডিফল্টভাবে enabled, যাতে Cloudflare/CAPTCHA চেক এলে আপনি visible browser window-তে নিজে verification করতে পারেন। CodeSpace security verification bypass করে না।
- Saved browser profile ও local data CodeSpaceData/Server/browser-profile-এ রাখা হয়। Portable folder writable হওয়া প্রয়োজন।

## Branding ও welcome screen

App চালু হলে CodeSpace logo ও **“Wellcome Mr. Rabiul” / “and Your Son: Arham”** welcome screen দেখাবে। `Open CodeSpace` চাপলে সঙ্গে সঙ্গে dismiss হবে; নইলে প্রায় 3.6 সেকেন্ড পর নিজে বন্ধ হবে।

## Data & limitations

- EXE-এর পাশে `CodeSpaceData\` folder-এ browser profile এবং app data থাকবে। Folder writable রাখুন এবং ব্যক্তিগত রাখুন, এতে saved cookies/login থাকতে পারে।
- OpenCode CLI নিজস্ব installation/login/configuration ব্যবহার করে; এই package OpenCode নিজে bundle করে না। Git, Python, Chrome/Edge এবং অন্যান্য external tools কিছু feature-এর জন্য host PC-তে লাগতে পারে।
- Build করতে internet এবং Windows x64 build PC দরকার। এই environment-এ final `.exe` compile করা হয়নি; এটি build-ready source ও automation।
- Unsigned build হলে Windows SmartScreen সতর্কতা দেখাতে পারে।

## Build commands

```bat
npm install
npm run runtime:fetch
npx electron-builder --win portable --x64
```
