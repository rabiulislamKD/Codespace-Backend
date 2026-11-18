# My Chat Agent v3 — Phase 3Z4 (বাংলা)

## কী বদলেছে

### Chat-এর activity indicator
- আগের বড় card বাদ; এখন শুধু সরু, শান্ত রঙের একটি line।
- ছোট ঘূর্ণায়মান circle-এর পাশে এক শব্দের status: **Thinking, Working, Reviewing, Waiting, Done, Failed, Stopped**।
- অতিরিক্ত detail, badge, রঙিন background, shadow ও pulse animation সরানো হয়েছে।
- উত্তর শেষ/ব্যর্থ/বন্ধ হলে status line নিজে থেকেই মিলিয়ে যায়।

### Workspace context আর chat-এ dump হবে না
- “Did you see my workspace?” ধরনের visibility প্রশ্নে auto smart retrieval ও project memory চালু হবে না।
- OpenCode mode-এ auto retrieval/context excerpt prompt-এ যোগ হয় না; OpenCode নিজেই open workspace দেখতে পারে।
- Model যদি তবুও `Smart code retrieval`, `Relevant project context` বা specialist review dump ফিরিয়ে দেয়, render করার আগে সেই block বাদ দেওয়া হবে।
- পুরনো chat history-তে save হওয়া context dump-ও load করার সময় পরিষ্কার করা হয়।
- Workspace visibility প্রশ্নে একমাত্র উত্তরটি dump হলে সংক্ষিপ্ত `Yes.` বা `No.` দেখানো হবে, workspace connection অনুযায়ী।

### Task Plan
- সব task complete হলে Plan panel এবং Plan button লুকিয়ে যায় এবং একই turn-এ আর ফিরে আসে না। নতুন user message হলে নতুন plan করা যেতে পারে।

## ইনস্টল
1. আপনার বর্তমান folder-এর backup রাখুন।
2. ZIP extract করে সব ফাইল একই project folder-এ রাখুন—বিশেষ করে `my-chat-agent-v3.html`, `agent-server.js` এবং `pwa/`।
3. Agent server চালু করে browser-এ app refresh করুন। Service-worker cache version বদলানো হয়েছে।

## যাচাই
```powershell
node --check agent-server.js
node --check verify.cjs
node verify.cjs
node verify-opencode-bridge.cjs
```

এই build-এ 81টি regression check এবং mock OpenCode bridge-এর 4টি check pass করেছে। Live provider বা browser end-to-end test চালানো হয়নি।
