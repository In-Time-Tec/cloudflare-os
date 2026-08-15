import type { RpcStub } from 'capnweb'
import type { ConversationsApi } from '@gadgets/workshop-shared/gatekeeper'

// Browser push registration for conversations. Best-effort everywhere: no push support, denied
// permission, or a missing VAPID key just means no notifications — the page still works.

function base64urlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const raw = atob(base64)
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}

/** Register the service worker and a push subscription, then hand it to the gatekeeper. */
export async function registerConversationsPush(api: RpcStub<ConversationsApi>): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
  try {
    const { pushPublicKey } = await api.getLiveEndpoint()
    if (!pushPublicKey) return

    const registration = await navigator.serviceWorker.register('/conversations-sw.js')
    if (Notification.permission === 'default') {
      // Requested from the Conversations page itself — a user surface, not an ambush.
      await Notification.requestPermission()
    }
    if (Notification.permission !== 'granted') return

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64urlToBytes(pushPublicKey) as BufferSource,
    })
    const json = subscription.toJSON()
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return
    await api.registerPush({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    })
  } catch (err) {
    console.debug('conversations push registration skipped', err)
  }
}
