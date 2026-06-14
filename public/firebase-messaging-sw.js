/* MOODCHAT — Firebase Cloud Messaging Service Worker */

/* Register click behavior before importing Firebase; otherwise FCM may override it. */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data=event.notification.data||{};
  const chatId=data.chatId||'';
  const targetUrl=new URL(data.url||(chatId?'/?chat='+encodeURIComponent(chatId):'/'),self.location.origin).href;

  event.waitUntil((async()=>{
    const windows=await clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of windows){
      try{
        client.postMessage({type:'OPEN_CHAT',chatId});
        if('navigate' in client && client.url!==targetUrl) await client.navigate(targetUrl);
        return client.focus();
      }catch{}
    }
    return clients.openWindow?clients.openWindow(targetUrl):undefined;
  })());
});

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:'AIzaSyAh9Y5sIwDI1pPlYARSOQJ4KY7ydS6zaBU',
  authDomain:'moodchat-f13a0.firebaseapp.com',
  projectId:'moodchat-f13a0',
  storageBucket:'moodchat-f13a0.firebasestorage.app',
  messagingSenderId:'196346161497',
  appId:'1:196346161497:web:baab4b0b87b94037f64448'
});

const messaging=firebase.messaging();

/* The Cloud Function sends data-only messages so this worker controls one notification. */
messaging.onBackgroundMessage(payload=>{
  const data=payload.data||{};
  // Notification payloads (for example Firebase Console tests) are displayed automatically.
  if(payload.notification && !Object.keys(data).length) return;

  const notification=payload.notification||{};
  const title=data.title||notification.title||'MOODCHAT';
  const body=data.body||notification.body||'You have a new notification';
  const chatId=data.chatId||'';
  const url=data.url||(chatId?'/?chat='+encodeURIComponent(chatId):'/');

  return self.registration.showNotification(title,{
    body,
    icon:'/icon-192.png',
    badge:'/badge-96.png',
    tag:chatId?'chat-'+chatId:(data.type||'moodchat'),
    renotify:true,
    data:{...data,chatId,url},
    vibrate:[180,80,180]
  });
});

self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(clients.claim()));
