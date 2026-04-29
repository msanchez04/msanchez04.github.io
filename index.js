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
        activity: { enum: ["Join", "Leave"] },
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
        void router.replace({ name: "home" });
      }
    },
  );

  const fakeTypingVisible = ref(false);
  let fakeTypingTimer;

  /** @type {Record<string, Array<{ id: string, title: string, due: string, completed: boolean }>>} */
  const todoLinesByChannel = reactive({});

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
        };
      } else if (e && typeof e === "object") {
        if (!e.id) e.id = crypto.randomUUID();
        if (typeof e.title !== "string") e.title = "";
        if (typeof e.due !== "string") e.due = "";
        if (typeof e.completed !== "boolean") e.completed = false;
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
    });
  }

  function patchTodoAt({ index, patch }) {
    const ch = selectedChannel.value;
    if (!ch || !patch || typeof index !== "number") return;
    const list = todoListFor(ch);
    if (index < 0 || index >= list.length) return;
    Object.assign(list[index], patch);
  }

  function removeTodoAt(index) {
    const ch = selectedChannel.value;
    if (!ch) return;
    const list = todoListFor(ch);
    if (index >= 0 && index < list.length) list.splice(index, 1);
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

  /** Latest activity per chat channel from private Join / Leave posts */
  const membershipByChannel = computed(() => {
    const map = new Map();
    const sorted = membershipObjects.value.toSorted(
      (a, b) => a.value.published - b.value.published,
    );
    for (const o of sorted) {
      map.set(o.value.target, o.value.activity);
    }
    return map;
  });

  const joinedChannels = computed(() => {
    const set = new Set();
    for (const [ch, act] of membershipByChannel.value) {
      if (act === "Join") set.add(ch);
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
      return sortedProjectsForSidebar.value.filter(
        (p) =>
          joinedChannels.value.has(p.value.channel) ||
          canonicalActorId(p.actor) ===
            canonicalActorId(session.value?.actor ?? ""),
      );
    }
    return sortedProjectsForSidebar.value;
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

  /** On ACL and has opened the chat (pin / join) — same gate as reading messages. */
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

  /** @returns {Promise<boolean>} */
  async function joinProject() {
    if (!selectedChannel.value || !session.value) return false;
    const pinCh = pinsChannelForSession(session.value);
    if (!pinCh) return false;
    isJoining.value = true;
    try {
      await graffiti.post(
        {
          value: {
            activity: "Join",
            target: selectedChannel.value,
            published: Date.now(),
          },
          channels: [pinCh],
          allowed: [],
        },
        session.value,
      );
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

  async function leaveProject() {
    if (!selectedChannel.value || !session.value) return;
    const ok = window.confirm(
      "Remove this group from your My projects list? You still have access unless the creator removes you from the access list.",
    );
    if (!ok) return;
    isLeaving.value = true;
    try {
      const pinCh = pinsChannelForSession(session.value);
      if (!pinCh) return;
      await graffiti.post(
        {
          value: {
            activity: "Leave",
            target: selectedChannel.value,
            published: Date.now(),
          },
          channels: [pinCh],
          allowed: [],
        },
        session.value,
      );
    } catch (e) {
      console.error(e);
      window.alert("Could not update your list. See the console for details.");
    } finally {
      isLeaving.value = false;
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

  function showFakeTyping() {
    clearTimeout(fakeTypingTimer);
    fakeTypingVisible.value = true;
    fakeTypingTimer = setTimeout(() => {
      fakeTypingVisible.value = false;
    }, 2200);
  }

  function onComposerInput() {
    if (canSendMessages.value) showFakeTyping();
  }

  return {
    session,
    listFilter,
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
    isDeletingGroup,
    isDeleting,
    isMemberOfSelected,
    canSendMessages,
    isOnAccessListForSelected,
    isCreatorOfSelected,
    selectedAllowedActors,
    joinedChannels,
    fakeTypingVisible,
    createProject,
    sendMessage,
    joinProject,
    addMemberToGroup,
    removeActorFromAccessList,
    isRosterRowRemovable,
    leaveProject,
    deleteEntireGroup,
    deleteMessage,
    selectProject,
    onComposerInput,
    routePanel,
    selectedTodos,
    addTodoForSelected,
    patchTodoAt,
    removeTodoAt,
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
