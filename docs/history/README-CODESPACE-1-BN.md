# CodeSpace — বাংলা সেটআপ ও Browser নির্দেশনা

## কী পরিবর্তন হয়েছে
- অ্যাপের নাম **CodeSpace** করা হয়েছে।
- চালু হলে CodeSpace logo এবং বড় অক্ষরে **“Wellcome Mr. Rabiul”** / **“and Your Son: Arham”** welcome splash দেখাবে। `Open CodeSpace` চাপলে সঙ্গে সঙ্গে বন্ধ হবে; না চাপলে প্রায় ৩.৬ সেকেন্ড পরে নিজে থেকে বন্ধ হবে।
- Browser-এর default mode এখন **Agent Chrome**। এতে URL একটি বাস্তব Chrome/Edge browser context-এ খোলে; Live page mode iframe-ভিত্তিক এবং কিছু site সেখানে লোড হতে দেবে না।
- Browser window visible ও cookies/profile persistent ডিফল্ট করা হয়েছে। পুরনো settings একবার migration হবে; Settings থেকে পরে বন্ধ করতে পারবেন।

## Cloudflare বিষয়ে
কোনো অ্যাপ বৈধভাবে সব Cloudflare verification নিশ্চিতভাবে সরিয়ে দিতে পারে না। যদি “Verify you are human” আসে, visible Chrome window-তে নিজে check সম্পন্ন করুন, তারপর CodeSpace-এর browser-এ Reload দিন। Profile persistent থাকলে অনেক ক্ষেত্রে cookie মনে থাকতে পারে। CAPTCHA/Cloudflare bypass করা হয়নি।

## চালানো
পুরনো project backup নিন; নতুন ZIP extract করে সব ফাইল একসঙ্গে ব্যবহার করুন। Bridge চালু করে CodeSpace page reload করুন। PWA install করা থাকলে cache update/reload দিন।

## পরীক্ষা
Source syntax, regression tests ও mock bridge tests চালানো হয়েছে। বাস্তব third-party site-এ live Cloudflare challenge test করা হয়নি।
