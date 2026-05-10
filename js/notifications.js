/**
 * Web Push Notifications wrapper.
 * Uses the standard Notification + Web Push APIs. The actual server-push
 * piece is handled by Firebase Cloud Messaging in production; here we set
 * up the subscription, request permission, and surface a helper for showing
 * local notifications when the app is running.
 */

import { getFirestore, getCurrentUser } from './auth.js';

const db = () => getFirestore();

export function isPushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    return { success: false, error: 'Notifications not supported' };
  }
  if (Notification.permission === 'granted') return { success: true, permission: 'granted' };
  if (Notification.permission === 'denied') {
    return { success: false, permission: 'denied', error: 'Notifications are blocked. Enable them in browser settings.' };
  }
  const permission = await Notification.requestPermission();
  return { success: permission === 'granted', permission };
}

/**
 * Subscribe the active service worker to push notifications and store the
 * subscription on the user's profile so the server can send pushes.
 *
 * NOTE: In production, set the VAPID public key in localStorage as
 * 'cribnotes_vapid_public' or pass it explicitly. Without one we still
 * register a service worker and can show local notifications.
 */
export async function subscribeToPush(vapidPublicKey) {
  try {
    if (!isPushSupported()) {
      return { success: false, error: 'Push not supported' };
    }
    const registration = await navigator.serviceWorker.ready;
    const key = vapidPublicKey || localStorage.getItem('cribnotes_vapid_public') || null;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription && key) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key)
      });
    }
    if (subscription) {
      const user = getCurrentUser();
      if (user) {
        await db().collection('users').doc(user.uid).update({
          pushSubscription: JSON.parse(JSON.stringify(subscription)),
          pushUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      }
    }
    return { success: true, subscription };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

/**
 * Show a local notification (works when app is in foreground or backgrounded
 * via the registered service worker).
 */
export async function showLocalNotification(title, options = {}) {
  if (!('Notification' in window)) return false;
  if (Notification.permission !== 'granted') {
    const r = await requestNotificationPermission();
    if (!r.success) return false;
  }
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, {
        body: options.body || '',
        icon: options.icon || '/icon-192.png',
        badge: options.badge || '/icon-192.png',
        tag: options.tag,
        data: options.data || {},
        requireInteraction: !!options.requireInteraction,
        vibrate: options.vibrate || [200, 100, 200]
      });
      return true;
    }
    new Notification(title, options);
    return true;
  } catch (e) {
    console.warn('[CribNotes] showLocalNotification failed:', e);
    return false;
  }
}

export function registerServiceWorker(scriptUrl = '/sw.js') {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.register(scriptUrl).catch(err => {
    console.warn('[CribNotes] service worker registration failed:', err);
    return null;
  });
}
