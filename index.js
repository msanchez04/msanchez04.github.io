import {
  createApp,
  defineAsyncComponent,
  ref,
  computed,
  reactive,
  watch,
  nextTick,
  onMounted,
  onUnmounted,
} from "vue";
import {
  createRouter,
  createWebHashHistory,
  useRoute,
  useRouter,
} from "vue-router";
import { GraffitiDecentralized } from "@graffiti-garden/implementation-decentralized";
import {
  GraffitiPlugin,
  useGraffiti,
  useGraffitiSession,
  useGraffitiDiscover,
} from "@graffiti-garden/wrapper-vue";

/** MIT-attested class bucket — posting fails for accounts without access. */
const DIRECTORY_CHANNEL_MIT = "mit:class:6.4500-groupchats";
/** Open fallback: same Create schema; merged into discover so any login can list groups. */
const DIRECTORY_CHANNEL_OPEN = "6.4500-groupchats-directory";

const DIRECTORY_DISCOVER_CHANNELS = [
  DIRECTORY_CHANNEL_MIT,
  DIRECTORY_CHANNEL_OPEN,
];

/** Pin/join markers live here so discover matches the tracker-style “actor/box” pattern. */
function pinsChannelForSession(sess) {
  if (!sess?.actor) return "";
  return `${sess.actor}/group-pins`;
}

const groupChatCreateSchema = {
  properties: {
    value: {
      required: ["activity", "type", "channel", "title", "published"],
      properties: {
        activity: { const: "Create" },
        type: { const: "GroupChat" },
        channel: { type: "string" },
        title: { type: "string" },
        course: { type: "string" },
        members: {
          type: "array",
          items: { type: "string" },
        },
        allowedActors: {
          type: "array",
          items: { type: "string" },
        },
        published: { type: "number" },
      },
    },
  },
};

const messageSchema = {
  properties: {
    value: {
      required: ["content", "published"],
      properties: {
        content: { type: "string" },
        published: { type: "number" },
      },
    },
  },
};

const membershipSchema = {
  properties: {
    value: {
      required: ["activity", "target", "published"],
      properties: {
        activity: {
          enum: ["Join", "Leave", "Pin", "Unpin"],
        },
        target: { type: "string" },
        published: { type: "number" },
      },
    },
  },
};

/**
 * Graffiti’s client compares `allowed` to `session.actor` with strict string
 * equality. DIDs from `handleToActor` may differ only by case from the logged-in
 * actor, which would hide listings for invited users.
 */
function canonicalActorId(id) {
  if (typeof id !== "string") return id;
  return id.startsWith("did:") ? id.toLowerCase() : id;
}

function dedupeActors(ids) {
  return [
    ...new Set(
      ids
        .filter((id) => typeof id === "string" && id.length > 0)
        .map((id) => canonicalActorId(id)),
    ),
  ];
}

function isActorOnAccessList(actor, actorList) {
  const me = canonicalActorId(actor);
  return actorList.some((a) => canonicalActorId(a) === me);
}

function splitInviteLines(raw) {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve one invite line: Graffiti handle (e.g. name.graffiti.actor) or did:… id.
 * @param {{ handleToActor: (h: string) => Promise<unknown> }} graffiti
 */
async function resolveInviteLineToActor(graffiti, raw) {
  const s = raw.trim().replace(/^@/, "");
  if (!s) return null;
  if (s.startsWith("did:")) {
    const d = canonicalActorId(s);
    return /^did:[a-z0-9]+:/i.test(d) ? d : null;
  }
  let handle = s;
  if (!handle.includes(".")) {
    handle = `${handle.toLowerCase()}.graffiti.actor`;
  } else {
    handle = handle.toLowerCase();
  }
  try {
    const out = await graffiti.handleToActor(handle);
    if (typeof out === "string" && out.startsWith("did:")) {
      return canonicalActorId(out);
    }
    if (out && typeof out === "object" && typeof out.actor === "string") {
      return canonicalActorId(out.actor);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{ ok: true, actors: string[] } | { ok: false, line: string }>}
 */
async function resolveInviteLines(graffiti, rawText) {
  const lines = splitInviteLines(rawText);
  const actors = [];
  for (const line of lines) {
    const id = await resolveInviteLineToActor(graffiti, line);
    if (!id) return { ok: false, line };
    actors.push(id);
  }
  return { ok: true, actors: dedupeActors(actors) };
}

/** Who may see the group + post (mirrors envelope `allowed` on the latest Create). */
function allowedActorsForProject(proj) {
  if (!proj?.value) return [];
  const fromVal = proj.value.allowedActors;
  if (Array.isArray(fromVal) && fromVal.length > 0) {
    return dedupeActors(fromVal);
  }
  return dedupeActors([proj.actor, ...(proj.value.members || [])]);
}

function setup() {
  const graffiti = useGraffiti();
  const session = useGraffitiSession();
  const route = useRoute();
  const router = useRouter();

  const listFilter = ref("all");
  /** Sidebar “Start a new group” form hidden until Make chat is clicked */
  const showCreateGroupPanel = ref(false);
  const selectedChannel = ref(null);
  const messagesEl = ref(null);

  const newTitle = ref("");
  const newCourse = ref("6.4500");
  const newMembersRaw = ref("");

  const draftMessage = ref("");
  const newMemberActorId = ref("");

  const isCreatingProject = ref(false);
  const isAddingMember = ref(false);
  const isSendingMessage = ref(false);
  const isJoining = ref(false);
  const isLeaving = ref(false);
  const isPinningSidebar = ref(false);
  const navigatingTaskChannel = ref(null);
  const isDeletingGroup = ref(false);
  const isDeleting = ref(new Set());

  /**
   * While the directory row is delete-then-reposted (ACL edit), discover briefly
   * drops the object — without a placeholder the sidebar row flickers out.
   */
  const aclDirectoryPlaceholder = ref(null);

  /**
   * After logout or switching Graffiti accounts, clear compose/create fields so
   * leftover invite lines (from another user’s session) do not fail resolve and
   * block creating a new group.
   */
  watch(
    () => session.value?.actor,
    (next, prev) => {
      if (prev !== undefined && next !== prev) {
        newTitle.value = "";
        newMembersRaw.value = "";
        newCourse.value = "6.4500";
        draftMessage.value = "";
        newMemberActorId.value = "";
        selectedChannel.value = null;
        aclDirectoryPlaceholder.value = null;
        showCreateGroupPanel.value = false;
        void router.replace({ name: "home" });
      }
    },
  );

  /**
   * Per-chat tasks (local only):
   * - due uses yyyy-mm-dd (date input format)
   * - syncedCalendarEventId links a task row to a personal calendar event
   */
  /** @type {Record<string, Array<{ id: string, title: string, due: string, completed: boolean, syncedCalendarEventId?: string | null }>>} */
  const todoLinesByChannel = reactive({});
  /** Personal app calendar events for the logged-in account (local only). */
  const personalCalendarEvents = ref([]);

  const routePanel = computed(() => {
    if (route.name === "chat-todos") return "todos";
    if (route.name === "chat-calendar") return "calendar";
    return null;
  });

  watch(
    () => route.params.chatId,
    (id) => {
      const next =
        id != null && String(id).length > 0 ? String(id) : null;
      if (selectedChannel.value !== next) {
        selectedChannel.value = next;
      }
    },
    { immediate: true },
  );

  function todoListFor(channel) {
    if (!channel) return [];
    if (!todoLinesByChannel[channel]) {
      todoLinesByChannel[channel] = [];
    }
    const list = todoLinesByChannel[channel];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (typeof e === "string") {
        list[i] = {
          id: crypto.randomUUID(),
          title: e,
          due: "",
          completed: false,
          syncedCalendarEventId: null,
        };
      } else if (e && typeof e === "object") {
        if (!e.id) e.id = crypto.randomUUID();
        if (typeof e.title !== "string") e.title = "";
        if (typeof e.due !== "string") e.due = "";
        if (typeof e.completed !== "boolean") e.completed = false;
        if (
          typeof e.syncedCalendarEventId !== "string" &&
          e.syncedCalendarEventId !== null
        ) {
          e.syncedCalendarEventId = null;
        }
      }
    }
    return list;
  }

  const selectedTodos = computed(() => todoListFor(selectedChannel.value));

  function addTodoForSelected() {
    const ch = selectedChannel.value;
    if (!ch) return;
    todoListFor(ch).push({
      id: crypto.randomUUID(),
      title: "",
      due: "",
      completed: false,
      syncedCalendarEventId: null,
    });
  }

  function sortCalendarEvents() {
    personalCalendarEvents.value.sort((a, b) => {
      const da = a.due || "9999-12-31";
      const db = b.due || "9999-12-31";
      if (da !== db) return da < db ? -1 : 1;
      const ta = (a.title || "").toLowerCase();
      const tb = (b.title || "").toLowerCase();
      return ta.localeCompare(tb);
    });
  }

  function calendarStorageKeyForActor(actor) {
    return `chatapp.personal-calendar.${canonicalActorId(actor || "anon")}`;
  }

  function todoStorageKeyForActor(actor) {
    return `chatapp.todos.${canonicalActorId(actor || "anon")}`;
  }

  function resetTodosInMemory() {
    for (const key of Object.keys(todoLinesByChannel)) {
      delete todoLinesByChannel[key];
    }
  }

  function sanitizeTodosByChannel(raw) {
    if (!raw || typeof raw !== "object") return {};
    const out = {};
    for (const [channel, rows] of Object.entries(raw)) {
      if (!Array.isArray(rows) || !channel) continue;
      out[channel] = rows
        .map((e) => {
          if (!e || typeof e !== "object") return null;
          const title = String(e.title ?? "");
          const due = String(e.due ?? "");
          const synced = e.syncedCalendarEventId;
          return {
            id: typeof e.id === "string" && e.id ? e.id : crypto.randomUUID(),
            title,
            due,
            completed: !!e.completed,
            syncedCalendarEventId:
              typeof synced === "string" || synced === null ? synced : null,
          };
        })
        .filter(Boolean);
    }
    return out;
  }

  function loadTodosForActor(actor) {
    resetTodosInMemory();
    if (!actor) return;
    try {
      const raw = localStorage.getItem(todoStorageKeyForActor(actor));
      const parsed = raw ? JSON.parse(raw) : {};
      const normalized = sanitizeTodosByChannel(parsed);
      for (const [channel, rows] of Object.entries(normalized)) {
        todoLinesByChannel[channel] = rows;
      }
    } catch {
      // Ignore storage parse errors; user starts with empty task state.
    }
  }

  function sanitizeCalendarEvents(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const e of raw) {
      if (!e || typeof e !== "object") continue;
      const title = String(e.title ?? "").trim();
      const due = String(e.due ?? "");
      if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(due)) continue;
      out.push({
        id: typeof e.id === "string" && e.id ? e.id : crypto.randomUUID(),
        title,
        due,
      });
    }
    return out;
  }

  function loadPersonalCalendarForActor(actor) {
    if (!actor) {
      personalCalendarEvents.value = [];
      return;
    }
    try {
      const raw = localStorage.getItem(calendarStorageKeyForActor(actor));
      const parsed = raw ? JSON.parse(raw) : [];
      personalCalendarEvents.value = sanitizeCalendarEvents(parsed);
      sortCalendarEvents();
    } catch {
      personalCalendarEvents.value = [];
    }
  }

  watch(
    () => session.value?.actor,
    (actor) => loadPersonalCalendarForActor(actor),
    { immediate: true },
  );

  watch(
    () => session.value?.actor,
    (actor) => loadTodosForActor(actor),
    { immediate: true },
  );

  watch(
    personalCalendarEvents,
    (next) => {
      const actor = session.value?.actor;
      if (!actor) return;
      try {
        localStorage.setItem(calendarStorageKeyForActor(actor), JSON.stringify(next));
      } catch {
        // Ignore localStorage failures.
      }
    },
    { deep: true },
  );

  watch(
    todoLinesByChannel,
    (next) => {
      const actor = session.value?.actor;
      if (!actor) return;
      try {
        localStorage.setItem(todoStorageKeyForActor(actor), JSON.stringify(next));
      } catch {
        // Ignore localStorage failures.
      }
    },
    { deep: true },
  );

  function addCalendarEvent({ title, due }) {
    const t = String(title ?? "").trim();
    const d = String(due ?? "");
    if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    personalCalendarEvents.value.push({
      id: crypto.randomUUID(),
      title: t,
      due: d,
    });
    sortCalendarEvents();
  }

  function patchCalendarEvent({ index, patch }) {
    if (!patch || typeof index !== "number") return;
    const list = personalCalendarEvents.value;
    if (index < 0 || index >= list.length) return;
    const next = { ...list[index], ...patch };
    next.title = String(next.title ?? "").trim();
    next.due = String(next.due ?? "");
    if (!next.title || !/^\d{4}-\d{2}-\d{2}$/.test(next.due)) return;
    list[index] = next;
    sortCalendarEvents();
  }

  function removeCalendarEvent(index) {
    if (typeof index !== "number") return;
    if (index < 0 || index >= personalCalendarEvents.value.length) return;
    const removed = personalCalendarEvents.value[index];
    personalCalendarEvents.value.splice(index, 1);
    for (const channel of Object.keys(todoLinesByChannel)) {
      const rows = todoListFor(channel);
      for (const task of rows) {
        if (task.syncedCalendarEventId === removed?.id) {
          task.syncedCalendarEventId = null;
        }
      }
    }
  }

  /** Keep task <-> personal calendar event in sync automatically. */
  function autosyncTaskToCalendar(channel, index) {
    if (!channel || typeof index !== "number") return;
    const list = todoListFor(channel);
    if (index < 0 || index >= list.length) return;
    const task = list[index];
    const title = String(task.title ?? "").trim();
    const due = String(task.due ?? "");
    const existingIdx = personalCalendarEvents.value.findIndex(
      (e) => e.id === task.syncedCalendarEventId,
    );
    const valid = !!title && /^\d{4}-\d{2}-\d{2}$/.test(due);

    // If task no longer has required fields, remove prior synced event link.
    if (!valid) {
      if (existingIdx >= 0) {
        personalCalendarEvents.value.splice(existingIdx, 1);
        sortCalendarEvents();
      }
      task.syncedCalendarEventId = null;
      return;
    }

    if (existingIdx >= 0) {
      personalCalendarEvents.value[existingIdx] = {
        ...personalCalendarEvents.value[existingIdx],
        title,
        due,
      };
    } else {
      const newEventId = crypto.randomUUID();
      personalCalendarEvents.value.push({ id: newEventId, title, due });
      task.syncedCalendarEventId = newEventId;
    }
    sortCalendarEvents();
  }

  function patchTodoForChannel(channel, index, patch) {
    if (!channel || !patch || typeof index !== "number") return;
    const list = todoListFor(channel);
    if (index < 0 || index >= list.length) return;
    Object.assign(list[index], patch);
    autosyncTaskToCalendar(channel, index);
  }

  function removeTodoForChannel(channel, index) {
    if (!channel) return;
    const list = todoListFor(channel);
    if (index >= 0 && index < list.length) {
      const task = list[index];
      const existingIdx = personalCalendarEvents.value.findIndex(
        (e) => e.id === task?.syncedCalendarEventId,
      );
      if (existingIdx >= 0) {
        personalCalendarEvents.value.splice(existingIdx, 1);
        sortCalendarEvents();
      }
      list.splice(index, 1);
    }
  }

  function patchTodoAt({ index, patch }) {
    const ch = selectedChannel.value;
    if (!ch) return;
    patchTodoForChannel(ch, index, patch);
  }

  function removeTodoAt(index) {
    const ch = selectedChannel.value;
    if (!ch) return;
    removeTodoForChannel(ch, index);
  }

  function closeRoutePanel() {
    const ch = selectedChannel.value ?? route.params.chatId;
    if (ch) {
      void router.push({ name: "chat", params: { chatId: String(ch) } });
    } else {
      void router.push({ name: "home" });
    }
  }

  function onGlobalKeydown(e) {
    if (e.key === "Escape" && routePanel.value) {
      e.preventDefault();
      closeRoutePanel();
    }
  }

  onMounted(() => {
    window.addEventListener("keydown", onGlobalKeydown);
  });

  onUnmounted(() => {
    window.removeEventListener("keydown", onGlobalKeydown);
  });

  const { objects: directoryObjects, isFirstPoll: directoryLoading } =
    useGraffitiDiscover(
      DIRECTORY_DISCOVER_CHANNELS,
      groupChatCreateSchema,
      () => session.value,
      true,
    );

  /** Post a directory Create; use MIT bucket when allowed, else open class feed. */
  async function postDirectoryCreate(value, sess) {
    try {
      await graffiti.post({ value, channels: [DIRECTORY_CHANNEL_MIT] }, sess);
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (!/bucket|not have access/i.test(msg)) throw e;
      await graffiti.post({ value, channels: [DIRECTORY_CHANNEL_OPEN] }, sess);
    }
  }

  function projectRowVisibleToSession(p, sess) {
    if (!sess) return false;
    const actors = allowedActorsForProject(p);
    return (
      isActorOnAccessList(sess.actor, actors) ||
      canonicalActorId(p.actor) === canonicalActorId(sess.actor)
    );
  }

  /**
   * Directory rows must NOT use envelope `allowed`: Graffiti masks those copies with
   * empty `channels`, and synchronizeDiscover drops any object whose channels do
   * not overlap the query—so invited users never saw listings. Access is enforced
   * here via `value.allowedActors` (and messages still use private `allowed`).
   */
  const projectsVisibleToSession = computed(() => {
    if (!session.value) return [];
    return directoryObjects.value.filter((p) =>
      projectRowVisibleToSession(p, session.value),
    );
  });

  const membershipChannels = computed(() => {
    const ch = pinsChannelForSession(session.value);
    return ch ? [ch] : [];
  });

  const { objects: membershipObjects, isFirstPoll: membershipLoading } =
    useGraffitiDiscover(
      () => membershipChannels.value,
      membershipSchema,
      () => session.value,
      true,
    );

  const sortedMembershipPosts = computed(() =>
    membershipObjects.value.toSorted(
      (a, b) => a.value.published - b.value.published,
    ),
  );

  /** Latest Join vs Leave per channel (message room / timeline). */
  const joinLeaveByChannel = computed(() => {
    const map = new Map();
    for (const o of sortedMembershipPosts.value) {
      const act = o.value.activity;
      if (act === "Join" || act === "Leave") {
        map.set(o.value.target, act);
      }
    }
    return map;
  });

  /** Latest Pin vs Unpin per channel (sidebar “My projects”). */
  const pinUnpinByChannel = computed(() => {
    const map = new Map();
    for (const o of sortedMembershipPosts.value) {
      const act = o.value.activity;
      if (act === "Pin" || act === "Unpin") {
        map.set(o.value.target, act);
      }
    }
    return map;
  });

  const joinedChannels = computed(() => {
    const set = new Set();
    for (const [ch, act] of joinLeaveByChannel.value) {
      if (act === "Join") set.add(ch);
    }
    return set;
  });

  /**
   * Pinned to “My projects”: explicit Pin/Unpin wins; legacy data with only
   * Join (no pin markers) treats Join as pinned until the user Unpins.
   */
  const pinnedChannels = computed(() => {
    const set = new Set();
    const pmap = pinUnpinByChannel.value;
    const jmap = joinLeaveByChannel.value;
    const channels = new Set([...pmap.keys(), ...jmap.keys()]);
    for (const ch of channels) {
      const pu = pmap.get(ch);
      if (pu === "Pin") {
        set.add(ch);
        continue;
      }
      if (pu === "Unpin") continue;
      if (jmap.get(ch) === "Join") set.add(ch);
    }
    return set;
  });

  /**
   * One row per chat channel. Tie-break equal `published` so two directory copies
   * (e.g. MIT + open feed) cannot flip winners on every poll and flicker the UI.
   */
  const latestProjectByChannel = computed(() => {
    const map = new Map();
    for (const p of projectsVisibleToSession.value) {
      const ch = p.value.channel;
      const prev = map.get(ch);
      if (!prev) {
        map.set(ch, p);
        continue;
      }
      const nextPub = p.value.published;
      const prevPub = prev.value.published;
      if (nextPub > prevPub) map.set(ch, p);
      else if (nextPub === prevPub && String(p.url) < String(prev.url)) {
        map.set(ch, p);
      }
    }
    return map;
  });

  function stashAclDirectoryPlaceholder(proj) {
    aclDirectoryPlaceholder.value = {
      channel: proj.value.channel,
      title: proj.value.title,
      course: proj.value.course || "6.4500",
      actor: proj.actor,
      members: dedupeActors(proj.value.members || []),
      allowedActors: allowedActorsForProject(proj),
      published: proj.value.published ?? Date.now(),
      supersededUrl: proj.url,
    };
  }

  function syntheticProjectForPlaceholder(ph) {
    return {
      value: {
        activity: "Create",
        type: "GroupChat",
        channel: ph.channel,
        title: ph.title,
        course: ph.course,
        members: ph.members,
        allowedActors: ph.allowedActors,
        published: ph.published,
      },
      actor: ph.actor,
      url: `local:acl-rebuild:${ph.channel}`,
    };
  }

  watch(
    () => {
      const ph = aclDirectoryPlaceholder.value;
      if (!ph) return null;
      return latestProjectByChannel.value.get(ph.channel) ?? null;
    },
    (proj) => {
      const ph = aclDirectoryPlaceholder.value;
      const sess = session.value;
      if (!ph || !proj || !sess) return;
      if (proj.url === ph.supersededUrl) return;
      if (!projectRowVisibleToSession(proj, sess)) return;
      aclDirectoryPlaceholder.value = null;
    },
  );

  const hasJoinedSelectedChat = computed(
    () =>
      !!(
        selectedChannel.value && joinedChannels.value.has(selectedChannel.value)
      ),
  );

  const messageDiscoverChannels = computed(() => {
    const ch = selectedChannel.value;
    const sess = session.value;
    if (!ch || !sess || !hasJoinedSelectedChat.value) return [];
    const proj = latestProjectByChannel.value.get(ch);
    if (
      !proj ||
      !isActorOnAccessList(sess.actor, allowedActorsForProject(proj))
    ) {
      return [];
    }
    return [ch];
  });

  const { objects: messageObjects, isFirstPoll: messagesLoadingRaw } =
    useGraffitiDiscover(
      () => messageDiscoverChannels.value,
      messageSchema,
      () => session.value,
      true,
    );

  const messagesLoading = computed(
    () => hasJoinedSelectedChat.value && messagesLoadingRaw.value,
  );

  const sortedProjectsForSidebar = computed(() => {
    const rows = [...latestProjectByChannel.value.values()];
    const ph = aclDirectoryPlaceholder.value;
    if (ph && !latestProjectByChannel.value.has(ph.channel)) {
      rows.push(syntheticProjectForPlaceholder(ph));
    }
    return rows.toSorted((a, b) => b.value.published - a.value.published);
  });

  const visibleProjects = computed(() => {
    if (listFilter.value === "mine") {
      /** Only chats explicitly pinned for this account (creator included). */
      return sortedProjectsForSidebar.value.filter((p) =>
        pinnedChannels.value.has(p.value.channel),
      );
    }
    return sortedProjectsForSidebar.value;
  });

  /** Every task row from every channel with project labels (sidebar “All tasks”). */
  const allTodosSidebar = computed(() => {
    const rows = [];
    for (const channel of Object.keys(todoLinesByChannel)) {
      const list = todoListFor(channel);
      if (!list.length) continue;
      const proj = latestProjectByChannel.value.get(channel);
      const projectTitle = proj?.value?.title ?? "Group";
      const course = proj?.value?.course ?? "—";
      for (let i = 0; i < list.length; i++) {
        const task = list[i];
        const title = String(task?.title ?? "").trim();
        if (!title) continue;
        rows.push({
          channel,
          index: i,
          task,
          projectTitle,
          course,
        });
      }
    }
    rows.sort((a, b) => {
      if (a.task.completed !== b.task.completed) {
        return a.task.completed ? 1 : -1;
      }
      const da = a.task.due || "9999-12-31";
      const db = b.task.due || "9999-12-31";
      if (da !== db) return da < db ? -1 : da > db ? 1 : 0;
      const ta = (a.task.title || "").toLowerCase();
      const tb = (b.task.title || "").toLowerCase();
      const c = ta.localeCompare(tb);
      if (c !== 0) return c;
      return a.projectTitle.localeCompare(b.projectTitle);
    });
    return rows;
  });

  const selectedProject = computed(() => {
    const ch = selectedChannel.value;
    if (!ch) return undefined;
    const live = latestProjectByChannel.value.get(ch);
    if (live) return live;
    const ph = aclDirectoryPlaceholder.value;
    if (ph && ph.channel === ch) return syntheticProjectForPlaceholder(ph);
    return undefined;
  });

  const sortedMessages = computed(() =>
    messageObjects.value.toSorted(
      (a, b) => a.value.published - b.value.published,
    ),
  );

  const isMemberOfSelected = computed(() =>
    selectedChannel.value
      ? joinedChannels.value.has(selectedChannel.value)
      : false,
  );

  const isPinnedForSelected = computed(() =>
    selectedChannel.value
      ? pinnedChannels.value.has(selectedChannel.value)
      : false,
  );

  /** On ACL and has opened the chat (Join) — same gate as reading messages. */
  const canSendMessages = computed(() => {
    if (!selectedProject.value || !session.value || !selectedChannel.value) {
      return false;
    }
    const onAcl = isActorOnAccessList(
      session.value.actor,
      allowedActorsForProject(selectedProject.value),
    );
    return onAcl && joinedChannels.value.has(selectedChannel.value);
  });

  const isOnAccessListForSelected = computed(() => {
    if (!selectedProject.value || !session.value) return false;
    return isActorOnAccessList(
      session.value.actor,
      allowedActorsForProject(selectedProject.value),
    );
  });

  const selectedAllowedActors = computed(() =>
    selectedProject.value ? allowedActorsForProject(selectedProject.value) : [],
  );

  const isCreatorOfSelected = computed(
    () =>
      !!(
        selectedProject.value &&
        session.value &&
        canonicalActorId(selectedProject.value.actor) ===
          canonicalActorId(session.value.actor)
      ),
  );

  watch(sortedMessages, async () => {
    await nextTick();
    const el = messagesEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });

  watch(selectedChannel, async () => {
    await nextTick();
    const el = messagesEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });

  function inviteResolveHelp() {
    return "Use a Graffiti handle like name.graffiti.actor, or a full id starting with did: (Graffiti uses did:plc:… — the letters are p-l-c, not “place”).";
  }

  async function createProject() {
    const title = newTitle.value.trim();
    if (!title || !session.value) return;
    isCreatingProject.value = true;
    try {
      const channel = crypto.randomUUID();
      const resolved = await resolveInviteLines(graffiti, newMembersRaw.value);
      if (!resolved.ok) {
        window.alert(
          `Could not resolve “${resolved.line}”.\n${inviteResolveHelp()}`,
        );
        return;
      }
      const members = resolved.actors;
      const allowed = dedupeActors([session.value.actor, ...members]);
      try {
        await postDirectoryCreate(
          {
            activity: "Create",
            type: "GroupChat",
            title,
            course: newCourse.value.trim() || "6.4500",
            channel,
            members,
            allowedActors: allowed,
            published: Date.now(),
          },
          session.value,
        );
      } catch (e) {
        console.error(e);
        window.alert(
          `Could not publish the new group (Graffiti error). ${e?.message ?? e}`,
        );
        return;
      }
      newTitle.value = "";
      newMembersRaw.value = "";
      showCreateGroupPanel.value = false;
      await router.push({ name: "chat", params: { chatId: channel } });
      const joined = await joinProject();
      if (!joined) {
        window.alert(
          "Group was created, but joining the chat failed—you will not see messages until you click Join project chat.",
        );
      }
    } finally {
      isCreatingProject.value = false;
    }
  }

  async function sendMessage() {
    const text = draftMessage.value.trim();
    if (
      !text ||
      !selectedChannel.value ||
      !session.value ||
      !canSendMessages.value ||
      !selectedProject.value
    ) {
      return;
    }
    isSendingMessage.value = true;
    try {
      const allowed = allowedActorsForProject(selectedProject.value);
      await graffiti.post(
        {
          value: {
            content: text,
            published: Date.now(),
          },
          channels: [selectedChannel.value],
          allowed,
        },
        session.value,
      );
      draftMessage.value = "";
    } finally {
      isSendingMessage.value = false;
    }
  }

  async function postPinsBoxActivity(sess, activity, targetChannel) {
    const pinCh = pinsChannelForSession(sess);
    if (!pinCh) return false;
    await graffiti.post(
      {
        value: {
          activity,
          target: targetChannel,
          published: Date.now(),
        },
        channels: [pinCh],
        allowed: [],
      },
      sess,
    );
    return true;
  }

  /** Join message room + show under My projects (Join + Pin on private inbox). */
  async function joinProject() {
    if (!selectedChannel.value || !session.value) return false;
    const target = selectedChannel.value;
    const pinCh = pinsChannelForSession(session.value);
    if (!pinCh) return false;
    isJoining.value = true;
    try {
      await graffiti.post(
        {
          value: {
            activity: "Join",
            target,
            published: Date.now(),
          },
          channels: [pinCh],
          allowed: [],
        },
        session.value,
      );
      try {
        await postPinsBoxActivity(session.value, "Pin", target);
      } catch (e2) {
        console.error(e2);
        window.alert(
          "You joined the chat, but pinning to My projects failed (check the console). Find the group under All projects.",
        );
      }
      return true;
    } catch (e) {
      console.error(e);
      window.alert(
        "Could not join this chat (network or Graffiti error). Check the console.",
      );
      return false;
    } finally {
      isJoining.value = false;
    }
  }

  async function addMemberToGroup() {
    const proj = selectedProject.value;
    const raw = newMemberActorId.value.trim();
    if (
      !proj ||
      !session.value ||
      canonicalActorId(proj.actor) !== canonicalActorId(session.value.actor)
    ) {
      return;
    }
    if (!proj.url || String(proj.url).startsWith("local:acl-rebuild:")) {
      window.alert("Still syncing this group—try again in a moment.");
      return;
    }
    const newActor = await resolveInviteLineToActor(graffiti, raw);
    if (!newActor) {
      window.alert(`Could not resolve “${raw}”.\n${inviteResolveHelp()}`);
      return;
    }
    const prev = allowedActorsForProject(proj);
    const next = dedupeActors([...prev, newActor]);
    if (next.length === prev.length) {
      window.alert("That person is already on the access list.");
      return;
    }
    isAddingMember.value = true;
    stashAclDirectoryPlaceholder(proj);
    try {
      await graffiti.delete(proj, session.value);
      await postDirectoryCreate(
        {
          activity: "Create",
          type: "GroupChat",
          title: proj.value.title,
          course: proj.value.course || "6.4500",
          channel: proj.value.channel,
          members: dedupeActors([...(proj.value.members || []), newActor]),
          allowedActors: next,
          published: Date.now(),
        },
        session.value,
      );
      newMemberActorId.value = "";
    } catch (e) {
      aclDirectoryPlaceholder.value = null;
      console.error(e);
      window.alert(
        `Could not save the updated access list. ${e?.message ?? e}\nIf this persists, ask the group creator to try again (directory bucket access).`,
      );
    } finally {
      isAddingMember.value = false;
    }
  }

  function isRosterRowRemovable(actorId) {
    const proj = selectedProject.value;
    const sess = session.value;
    if (!proj || !sess) return false;
    if (canonicalActorId(proj.actor) !== canonicalActorId(sess.actor)) {
      return false;
    }
    return canonicalActorId(actorId) !== canonicalActorId(proj.actor);
  }

  async function removeActorFromAccessList(actorId) {
    const proj = selectedProject.value;
    if (!proj || !session.value) return;
    if (!proj.url || String(proj.url).startsWith("local:acl-rebuild:")) {
      window.alert("Still syncing this group—try again in a moment.");
      return;
    }
    if (
      canonicalActorId(proj.actor) !== canonicalActorId(session.value.actor)
    ) {
      return;
    }
    const target = canonicalActorId(actorId);
    if (target === canonicalActorId(proj.actor)) {
      window.alert(
        "You cannot remove yourself as creator from the access list.",
      );
      return;
    }
    const prev = allowedActorsForProject(proj);
    if (!isActorOnAccessList(target, prev)) return;
    const ok = window.confirm(
      "Remove this person from the access list? They will stop seeing this group and new messages after the next sync.",
    );
    if (!ok) return;
    let next = dedupeActors(prev.filter((a) => canonicalActorId(a) !== target));
    if (next.length === prev.length) return;
    if (!isActorOnAccessList(proj.actor, next)) {
      next = dedupeActors([proj.actor, ...next]);
    }
    const prevMembers = proj.value.members || [];
    const nextMembers = dedupeActors(
      prevMembers.filter((a) => canonicalActorId(a) !== target),
    );
    isAddingMember.value = true;
    stashAclDirectoryPlaceholder(proj);
    try {
      await graffiti.delete(proj, session.value);
      await postDirectoryCreate(
        {
          activity: "Create",
          type: "GroupChat",
          title: proj.value.title,
          course: proj.value.course || "6.4500",
          channel: proj.value.channel,
          members: nextMembers,
          allowedActors: next,
          published: Date.now(),
        },
        session.value,
      );
    } catch (e) {
      aclDirectoryPlaceholder.value = null;
      console.error(e);
      window.alert(
        `Could not update the access list. ${e?.message ?? e}\nIf this persists, try again (directory bucket access).`,
      );
    } finally {
      isAddingMember.value = false;
    }
  }

  /** Only removes the group from My projects; message room unchanged (stay Joined). */
  async function unpinFromMyProjects() {
    if (!selectedChannel.value || !session.value) return;
    const ok = window.confirm(
      "Remove this group from My projects?\n\nYou stay in the chat: open it again from All projects to read or send messages. Use Pin to My projects to bring it back to your sidebar list.",
    );
    if (!ok) return;
    isLeaving.value = true;
    try {
      await postPinsBoxActivity(session.value, "Unpin", selectedChannel.value);
    } catch (e) {
      console.error(e);
      window.alert(
        "Could not unpin from My projects. See the console for details.",
      );
    } finally {
      isLeaving.value = false;
    }
  }

  async function pinToMyProjects() {
    if (!selectedChannel.value || !session.value) return;
    if (!joinedChannels.value.has(selectedChannel.value)) return;
    isPinningSidebar.value = true;
    try {
      await postPinsBoxActivity(session.value, "Pin", selectedChannel.value);
    } catch (e) {
      console.error(e);
      window.alert(
        "Could not pin this chat to My projects. See the console for details.",
      );
    } finally {
      isPinningSidebar.value = false;
    }
  }

  async function deleteEntireGroup() {
    const proj = selectedProject.value;
    if (
      !proj ||
      !session.value ||
      canonicalActorId(proj.actor) !== canonicalActorId(session.value.actor)
    ) {
      return;
    }
    const ok = window.confirm(
      `Delete “${proj.value.title}” for everyone? It will disappear from the project list. Message history may still exist on the network for people who already had the room open.`,
    );
    if (!ok) return;
    isDeletingGroup.value = true;
    try {
      await graffiti.delete(proj, session.value);
      void router.replace({ name: "home" });
    } finally {
      isDeletingGroup.value = false;
    }
  }

  async function deleteMessage(obj) {
    if (!session.value) return;
    isDeleting.value.add(obj.url);
    try {
      await graffiti.delete(obj, session.value);
    } finally {
      isDeleting.value.delete(obj.url);
    }
  }

  function selectProject(project) {
    void router.push({
      name: "chat",
      params: { chatId: project.value.channel },
    });
  }

  function openChatFromTaskSidebar(channelId) {
    if (!channelId) return;
    navigatingTaskChannel.value = String(channelId);
    void router.push({
      name: "chat-todos",
      params: { chatId: String(channelId) },
    });
    setTimeout(() => {
      if (navigatingTaskChannel.value === String(channelId)) {
        navigatingTaskChannel.value = null;
      }
    }, 260);
  }

  return {
    session,
    listFilter,
    showCreateGroupPanel,
    selectedChannel,
    selectedProject,
    visibleProjects,
    sortedMessages,
    messagesEl,
    newTitle,
    newCourse,
    newMembersRaw,
    newMemberActorId,
    draftMessage,
    directoryLoading,
    membershipLoading,
    messagesLoading,
    isCreatingProject,
    isAddingMember,
    isSendingMessage,
    isJoining,
    isLeaving,
    isPinningSidebar,
    navigatingTaskChannel,
    isDeletingGroup,
    isDeleting,
    isMemberOfSelected,
    isPinnedForSelected,
    canSendMessages,
    isOnAccessListForSelected,
    isCreatorOfSelected,
    selectedAllowedActors,
    joinedChannels,
    pinnedChannels,
    createProject,
    sendMessage,
    joinProject,
    addMemberToGroup,
    removeActorFromAccessList,
    isRosterRowRemovable,
    unpinFromMyProjects,
    pinToMyProjects,
    deleteEntireGroup,
    deleteMessage,
    selectProject,
    routePanel,
    selectedTodos,
    personalCalendarEvents,
    addTodoForSelected,
    patchTodoAt,
    patchTodoForChannel,
    removeTodoAt,
    removeTodoForChannel,
    addCalendarEvent,
    patchCalendarEvent,
    removeCalendarEvent,
    allTodosSidebar,
    openChatFromTaskSidebar,
    closeRoutePanel,
  };
}

/** Studio 11 style: default export is an async factory that returns component options. */
function loadHtmlComponent(specifier) {
  return () =>
    import(specifier).then(async (m) => {
      const factory = m.default;
      return await factory();
    });
}

const RoutedModalShell = defineAsyncComponent(
  loadHtmlComponent("./components/routed-modal/main.js"),
);
const TodoPanel = defineAsyncComponent(
  loadHtmlComponent("./components/todo-panel/main.js"),
);
const CalendarPanel = defineAsyncComponent(
  loadHtmlComponent("./components/calendar-panel/main.js"),
);

const App = {
  template: "#template",
  setup,
  components: {
    RoutedModalShell,
    TodoPanel,
    CalendarPanel,
  },
};

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "home", component: App },
    { path: "/home", redirect: { name: "home" } },
    { path: "/chat/:chatId", name: "chat", component: App },
    { path: "/chat/:chatId/todos", name: "chat-todos", component: App },
    { path: "/chat/:chatId/calendar", name: "chat-calendar", component: App },
  ],
});

const Root = { template: "<router-view />" };

createApp(Root)
  .use(GraffitiPlugin, {
    graffiti: new GraffitiDecentralized(),
  })
  .use(router)
  .mount("#app");
