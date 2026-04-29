Graffiti is a system for posting and discovering social data - small "objects" representing social actions as well as "media" for images/video/etc. Graffiti comes with a Vue plugin which exposes reactive variables for login sessions and object discovery.

Abridged docs below, full docs here:
API: https://api.graffiti.garden/classes/Graffiti.html
Vue Plugin: https://vue.graffiti.garden/variables/GraffitiPlugin.html

INSTALL
import { createApp } from "vue"
import { GraffitiDecentralized } from "@graffiti-garden/implementation-decentralized"
import { GraffitiPlugin, useGraffiti, ... } from "@graffiti-garden/wrapper-vue"

function setup() {
  const graffiti = useGraffiti();

  async function postMessage() {
    await graffiti.post(...)
  }

  ...

  return { postMessage }
}

createApp({
  template: "#template",
  setup
}).use(GraffitiPlugin, { graffiti: new GraffitiDecentralized() })
  .mount("#app")

GRAFFITI OBJECT MODEL (must adhere)
GraffitiObject contains:
- value: freeform JSON but prefer Activity Vocabulary properties when appropriate.
- channels: string[] (discoverable ONLY by querying channels)
- allowed?: string[] | null (omitted/undefined => public; empty [] => creator-only; list => restricted to listed actors)
- actor: string (creator; only creator can delete)
- url: string (unique object identifier/locator)

GRAFFITI MEDIA MODEL (must adhere)
GraffitiMedia contains:
- data: Blob (binary data plus media type)
- actor: string (uploader; only uploader can delete)
- allowed?: string[] | null (same as for objects)

LOGIN SESSIONS
- interface GraffitiSession { actor: string; }
- session: ref<GraffitiSession | undefined | null>
  - undefined => initializing (show "Loading...")
  - null => logged out (show "Log in" button calling graffiti.login())
  - { actor } => logged in (show "Log out" calling graffiti.logout(session))
- In Composition API:
  import { useGraffitiSession } from "@graffiti-garden/wrapper-vue"
  function setup() {
    const session = useGraffitiSession()
    const actor = session.value?.actor
  }

OBJECT SCHEMAS
- Fetching graffiti objects requires a JSON Schema that will filter for objects matching a specific shape.
- Using the schema {} will match everything, but DO NOT USE UNLESS NECESSARY.
- The schema applies to the whole object (value, channels, allowed, actor, url). Generally just filtering for value is OK, but filtering actor can be useful if you only want objects by a certain set of actors.
- Start from this base schema:
  - { properties: { value: { properties: {}, required: [] } } }

GRAFFITI API (use only these; respect the parameter/return shapes)
You may use these methods; do not invent other APIs:

- post
    partialObject: { value: {}, channels: string[], allowed?: string[] | null },
    session: GraffitiSession
  ) => Promise<GraffitiObject>
  - Provide everything except actor/url; they're assigned and returned.

- get(
    url: string | { url: string },
    schema: JSONSchema,
    session?: GraffitiSession | null
  ) => Promise<GraffitiObject>
  - Validates against required JSON schema.
  - If session omitted, object must be public (allowed undefined).
  - Only use session if you explicitly want to include private objects
  - If retriever != creator, allowed/channels are masked (BCC-like).

- delete(
    url: string | { url: string },
    session: GraffitiSession
  ) => Promise<GraffitiObjectBase>
  - Only creator may delete.

- postMedia(
    partialMedia: { data: Blob, allowed?: string[] | null },
    session: GraffitiSession
  ) => Promise<string>
  - Provide every thing except actor; it's assigned and returned.
  - Returns media URL; media is NOT discoverable.

- getMedia(mediaUrl: string, accept: { types?: string[] }, session?: GraffitiSession | null)
  => Promise<GraffitiMedia>
  - Accept types are mime types (e.g. image/* , text/plain); if no match, call fails.
  - Accept is REQUIRED even if you want to accept all types: getMedia(url, {})
  - If session omitted, media must be public (allowed undefined/null).
  - Only use session if you explicitly want to include private media

- deleteMedia(mediaUrl: string, session: GraffitiSession) => Promise<void>
  - Only poster may delete.

- login() => Promise<void>
  - Must be called from a user gesture (button).

- logout(session: GraffitiSession) => Promise<void>
  - Must be called from a user gesture (button).

- actorToHandle(actor: string) => Promise<string>
  - For display only; handles can change.

- handleToActor(handle: string) => Promise<string>

MODIFYING OBJECTS AND DELETING
- Objects cannot be changed and only an object's creator can delete an object.
- To enable editing, post { activity: 'Update' } objects, discover and interpret them appropriately.
- To enable deletion by non-owners, post { activity: 'Remove' } objects then discover and interpet them as appropriate.
- Create additional objects to enable other forms of collaboration and moderation.

VUE WRAPPER: GLOBALS + COMPOSITION HELPERS (use only these)
- In templates / Options API:
  - $graffiti (Graffiti instance)
  - $graffitiSession (Ref<GraffitiSession | null | undefined>)
- Composition API (must import):
  - useGraffiti(): Graffiti
  - useGraffitiSession(): Ref<GraffitiSession | null | undefined>

VUE COMPOSABLE SHAPES (components are equivalent, but outputs come via v-slot)

1) useGraffitiDiscover(
     channels: MaybeRefOrGetter<string[]>,
     schema: MaybeRefOrGetter<JSONSchema>,
     session?: MaybeRefOrGetter<GraffitiSession | null | undefined>,
     autopoll?: MaybeRefOrGetter<boolean>,
   ) => {
     isFirstPoll: Ref<boolean>;
     objects: Ref<GraffitiObject<Schema>[]>;
     poll: () => Promise<void>;
   }
   - If session omitted, will only return public objects (allowed undefined/null).
   - Only use session if you explicitly want to include private objects
   - Component <graffiti-discover :channels="[...]" :schema="{...}" ...>
     - Emits the same outputs through v-slot: { objects, isFirstPoll, poll }
   - AUTOPOLL IS RESOURCE HEAVY and should be used AT MOST ONCE to enable real-time updates (e.g. messaging).
   - Local changes (put, delete) propogate to discover in real-time by default and at no penalty - no autopoll necessary.
   - YOU MUST PASS AN ARRAY OF CHANNELS EVEN IF YOU ARE ONLY LISTENING TO ONE: :channels="['my-channel']"

2) useGraffitiGet(
     url: MaybeRefOrGetter<string | GraffitiObjectUrl>,
     schema: MaybeRefOrGetter<JSONSchema>,
     session?: MaybeRefOrGetter<GraffitiSession | null | undefined>,
   ) => {
     object: Ref<GraffitiObject<Schema> | null | undefined>;
     poll: () => Promise<void>;
   }
   - If session omitted, will only return public objects (allowed undefined/null).
   - Only use session if you explicitly want to include private objects
   - object is undefined while loading, null if not found.
   - Component equivalent: <graffiti-get :url="" :schema="{ ... }"> via v-slot: { object, poll }

3) useGraffitiGetMedia(
     url: MaybeRefOrGetter<string>,
     accept: MaybeRefOrGetter<GraffitiMediaAccept>,
     session?: MaybeRefOrGetter<GraffitiSession | null | undefined>,
   ) => {
     media: Ref<GraffitiMedia & { dataUrl: string } | null | undefined>;
     poll: () => Promise<void>;
   }
   - Also provides a dataUrl field for convenient media rendering.
   - media is undefined while loading, null if not found or accept mismatch.
   - Component equivalent: <graffiti-get-media :url="url" :accept="{ ... }" ...> via v-slot: { media, poll }
   - Accept is REQUIRED even if you want to accept all types. In that case accept={}
   - By default, component already displays most types of media (images, pdf, audio, video, etc.) with a download button fallback. So unless you want to process the media itself, do not put any template code within the <graffiti-get-media></..> tag
   - If session omitted, will only return public media (allowed undefined/null).
   - Only use session if you explicitly want to include private media

3) useGraffitiActorToHandle(
     actor: MaybeRefOrGetter<string>
   ) => { handle: Ref<string | null | undefined> }
   - handle undefined while loading; null if not found.
   - Component equivalent: <graffiti-actor-to-handle :actor="actor"> via v-slot: { handle }
  - By default, component will display the actor so don't put anything inside the tags unless you want to do something with it.

4) useGraffitiHandleToActor(
     handle: MaybeRefOrGetter<string>
   ) => { actor: Ref<string | null | undefined> }
   - actor undefined while loading; null if not found.
   - Component equivalent: <graffiti-handle-to-actor :handle="handle"> via v-slot: { actor }
   - By default, component will display the handle so don't put anything inside the tags unless you want to do something with it.

GOTCHAS
- DOUBLE CHECK that you are passing an ARRAY OF CHANNELS, even if you are only using one: <graffiti-discover :channels="['my-channel']" ...>
- DOUBLE CHECK that your schemas are relative to the WHOLE OBJECT, not just the object's value: { properties: { value: { properties: {...}, required: [...] } } }
- Graffiti is interoperable so you cannot prevent others from posting to your channels outside your UI.
  - Mitigate by filtering displayed objects (e.g., only owner-authored posts) + schema constraints.
